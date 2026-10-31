import { applyFill, lossToday, sumToday, unitsToNumber, usdToUnits, type Book } from "@norr/core";
import type { BuildInfo } from "../build-info";
import type { SealKeyStore, SealingLedger } from "../seal";
import { FUNDING_WINDOW_MS, FundingTracker, MAX_OPEN_FUNDING, fundingState } from "../funding";
import { CASH_USD } from "../portfolio";
import { Policy } from "@norr/shared";
import type { Hono } from "hono";
import { z } from "zod";
import { valueLayers } from "../portfolio";
import type { AgentTokens } from "../tokens";
import type { TradeDeps } from "../trade";
import type { OwnerAuth } from "./auth";

/** What an owner did through the dashboard, newest last. Kept in memory for now. */
export interface OwnerAuditEntry {
  at: string;
  owner: string;
  action: string;
  vaultId?: string;
}

export interface OwnerRouteContext {
  deps: TradeDeps;
  tokens: AgentTokens;
  auth: OwnerAuth;
  mock: boolean;
  /** The code version shown on the Verify screen. */
  build: BuildInfo;
  seal?: { keys: SealKeyStore; ledger: SealingLedger };
  audit: OwnerAuditEntry[];
}

const LoginBody = z.object({
  accountId: z.string().min(2).max(64),
  publicKey: z.string().min(10).max(120),
  signature: z.string().min(40).max(200),
  nonce: z.string().min(40).max(60),
  callbackUrl: z.string().max(500).optional(),
});

/**
 * Owner-only API for the dashboard (`/owner/v1`). Sign-in is a NEAR wallet message signature; a session
 * can only see and change vaults whose `owner` is the signed-in account (anything else is a 404, so
 * vault ids do not leak). Agent tokens cannot call any of this, and sessions cannot call `/v1`.
 */
export function mountOwnerRoutes(app: Hono<any>, ctx: OwnerRouteContext): void {
  const { deps, tokens, auth } = ctx;
  const note = (owner: string, action: string, vaultId?: string) => ctx.audit.push({ at: new Date(deps.now()).toISOString(), owner, action, ...(vaultId ? { vaultId } : {}) });

  const funding = new FundingTracker();

  app.get("/owner/v1/challenge", (c) => c.json(auth.challenge()));

  app.post("/owner/v1/login", async (c) => {
    const parsed = LoginBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "sign-in failed" }, 401);
    const session = await auth.login(parsed.data);
    if (!session) return c.json({ error: "sign-in failed" }, 401);
    note(session.accountId, "signed in");
    return c.json(session);
  });

  app.use("/owner/v1/*", async (c, next) => {
    const m = /^Bearer (norr_owner_.+)$/.exec(c.req.header("authorization") ?? "");
    const session = m?.[1] ? auth.session(m[1]) : null;
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("owner", session.accountId);
    c.set("ownerToken", m![1]);
    await next();
  });

  const mine = (owner: string, id: string) => {
    const v = deps.vaults.get(id);
    return v && v.owner === owner ? v : undefined;
  };
  const summary = (v: NonNullable<ReturnType<typeof mine>>) => ({
    id: v.id,
    walletAccount: v.walletAccount,
    policy: v.policy,
    paused: v.policy.paused,
    // Computed now from the vault's day totals, not from the cached copy that only a trade refreshes.
    state: { spentTodayUsd: sumToday(v.spend, deps.now()), realizedLossTodayUsd: lossToday(v.pnl, deps.now()), lastTradeAt: v.state.lastTradeAtMs ? new Date(v.state.lastTradeAtMs).toISOString() : null },
  });

  app.get("/owner/v1/me", (c) => {
    const owner = c.get("owner") as string;
    return c.json({ accountId: owner, vaults: deps.vaults.list().filter((v) => v.owner === owner).length, mock: ctx.mock });
  });

  app.post("/owner/v1/logout", (c) => {
    auth.logout(c.get("ownerToken") as string);
    return c.json({ ok: true });
  });

  app.get("/owner/v1/vaults", (c) => {
    const owner = c.get("owner") as string;
    return c.json({ vaults: deps.vaults.list().filter((v) => v.owner === owner).map(summary) });
  });

  app.get("/owner/v1/vaults/:id", async (c) => {
    const v = mine(c.get("owner") as string, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    let portfolio: unknown = null;
    try {
      portfolio = valueLayers({ public: deps.balances ? await deps.balances.holdings(v.walletAccount) : undefined, confidential: await v.custody.confidentialHoldings() }, deps.registry);
    } catch {
      /* balances unavailable: the rest of the page still works */
    }
    return c.json({ ...summary(v), portfolio });
  });

  // Funding: the owner asks for a one-time confidential deposit address, sends USDC to it from their own wallet,
  // and watches for it to arrive. The address always comes from the custody provider; nothing here takes one from a caller.
  const FundBody = z.object({ amountUsdc: z.number().min(1).max(1000), fromAccount: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/).optional() });
  const cash = () => deps.quoteAsset;
  const SAFE_ADDRESS = /^[A-Za-z0-9._-]{8,128}$/;

  app.post("/owner/v1/vaults/:id/funding", async (c) => {
    const owner = c.get("owner") as string;
    const v = mine(owner, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    const body = FundBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "amountUsdc must be a number from 1 to 1000" }, 400);
    const now = deps.now();
    if (funding.open(v.id, now).length >= MAX_OPEN_FUNDING) return c.json({ error: "Too many open deposit requests. Use one of them, or wait for them to expire." }, 429);
    try {
      const baseline = (await v.custody.confidentialHoldings())[cash().id] ?? "0";
      const amount = usdToUnits(body.data.amountUsdc, CASH_USD, cash().decimals);
      // Norr's own 1Click quote is the source (nothing depends on the custody policy); the custody provider is the fallback.
      // Either way the recipient is the vault itself, set here, and the refund goes to the account the owner sends from.
      const refundTo = body.data.fromAccount ?? owner;
      const source = deps.funder ? "1click" : "custody";
      const req = deps.funder
        ? await deps.funder.requestDeposit({ token: cash().id, amount, recipient: v.walletAccount, refundTo }).then((o) => ({ intentId: o.depositAddress, depositAddress: o.depositAddress, amount: o.amountIn, minAmountOut: o.minAmountOut }))
        : await v.custody.requestConfidentialDeposit(cash().id, amount);
      if (!SAFE_ADDRESS.test(req.depositAddress)) return c.json({ error: "The address returned does not look valid, so it is not shown." }, 502);
      const id = `fund-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const expiresAt = now + FUNDING_WINDOW_MS;
      funding.add({ id, vaultId: v.id, token: cash().id, amount: req.amount, minAmount: req.minAmountOut, address: req.depositAddress, intentId: req.intentId, source, baseline, requestedAt: now, expiresAt });
      note(owner, `requested a deposit address for ${body.data.amountUsdc} USDC`, v.id);
      return c.json({ id, address: req.depositAddress, amountUsdc: unitsToNumber(req.amount, cash().decimals), asset: { symbol: cash().symbol, chain: "NEAR", contract: cash().id.replace(/^nep141:/, "") }, expiresAt: new Date(expiresAt).toISOString() });
    } catch (e) {
      // The custody provider gates this request by transaction type ("call"). Say so, rather than a vague failure.
      if (e instanceof Error && /not allowed by policy/i.test(e.message)) {
        return c.json({ error: "Your custody policy does not allow deposit-address requests (transaction type \"call\"). Allow it in your custody dashboard while you fund this vault, then remove it again." }, 409);
      }
      return c.json({ error: "Could not get a deposit address from the custody provider. Try again in a moment." }, 503);
    }
  });

  app.get("/owner/v1/vaults/:id/funding/:fid", async (c) => {
    const v = mine(c.get("owner") as string, c.req.param("id"));
    const r = v ? funding.get(c.req.param("fid")) : undefined;
    if (!v || !r || r.vaultId !== v.id) return c.json({ error: "not found" }, 404);
    try {
      const balance = (await v.custody.confidentialHoldings())[r.token] ?? "0";
      const s = fundingState(r, balance, deps.now());
      // 1Click's own status is an independent witness for a deposit address it issued; the balance is the custody provider's report.
      const executed = r.source === "1click" ? await deps.auditor.audit(r.address).catch(() => null) : null;
      const independentlyConfirmed = executed !== null && executed.recipient === v.walletAccount && executed.tokenOut === r.token && BigInt(executed.amountOut) >= BigInt(r.minAmount);
      return c.json({ state: s.state, receivedUsdc: unitsToNumber(s.received, cash().decimals), balanceUsdc: unitsToNumber(balance, cash().decimals), expiresAt: new Date(r.expiresAt).toISOString(), reportedBy: "custody provider", independentlyConfirmed });
    } catch {
      return c.json({ error: "Could not read the vault's balance right now." }, 503);
    }
  });

  // The key the owner's private reasoning is sealed to. The browser derives it from a wallet signature and
  // sends only the public half; the private half never leaves the browser.
  app.get("/owner/v1/seal-key", (c) => c.json({ publicKey: ctx.seal?.keys.get(c.get("owner") as string) ?? null }));

  app.put("/owner/v1/seal-key", async (c) => {
    const owner = c.get("owner") as string;
    if (!ctx.seal) return c.json({ error: "private reasoning is not available on this service" }, 501);
    const body = z.object({ publicKey: z.string().min(40).max(48) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid key" }, 400);
    try {
      ctx.seal.keys.set(owner, body.data.publicKey);
    } catch {
      return c.json({ error: "invalid key" }, 400);
    }
    // Reasoning stored before the owner had a key moves to it now; the service can no longer read it.
    let resealed = 0;
    for (const v of deps.vaults.list().filter((x) => x.owner === owner)) resealed += ctx.seal.ledger.reseal(v.id, body.data.publicKey);
    note(owner, "enrolled a key for private reasoning");
    return c.json({ publicKey: body.data.publicKey, resealed });
  });

  app.put("/owner/v1/vaults/:id/policy", async (c) => {
    const owner = c.get("owner") as string;
    const v = mine(owner, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body && body.vaultId !== undefined && body.vaultId !== v.id) return c.json({ error: "vaultId cannot be changed" }, 400);
    const parsed = Policy.safeParse({ ...(body ?? {}), vaultId: v.id });
    if (!parsed.success) return c.json({ error: "invalid policy", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    deps.vaults.setPolicy(v.id, parsed.data);
    note(owner, "changed rules", v.id);
    return c.json({ policy: deps.vaults.get(v.id)!.policy });
  });

  app.post("/owner/v1/vaults/:id/pause", (c) => {
    const owner = c.get("owner") as string;
    const v = mine(owner, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    deps.vaults.pause(v.id, "paused by owner");
    note(owner, "paused", v.id);
    return c.json({ paused: true });
  });

  app.post("/owner/v1/vaults/:id/resume", (c) => {
    const owner = c.get("owner") as string;
    const v = mine(owner, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    deps.vaults.resume(v.id);
    note(owner, "resumed", v.id);
    return c.json({ paused: false });
  });

  // The kill switch: one call pauses every vault this owner has.
  app.post("/owner/v1/pause-all", (c) => {
    const owner = c.get("owner") as string;
    const ids = deps.vaults.list().filter((v) => v.owner === owner).map((v) => v.id);
    for (const id of ids) deps.vaults.pause(id, "paused by owner (kill switch)");
    note(owner, "kill switch: paused all vaults");
    return c.json({ paused: ids });
  });

  // The owner sees the agent's stated reasoning; nobody else does.
  app.get("/owner/v1/vaults/:id/activity", (c) => {
    const v = mine(c.get("owner") as string, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    const all = deps.ledger.list(v.id);
    // What each executed trade actually moved, and the realized P&L of each sell, replayed in order with the
    // same average-cost rule the loss cap uses (a sell only realizes the part Norr bought).
    const executed = new Map<string, { usd: number; realizedUsd: number | null }>();
    let book: Book = {};
    for (const r of all) {
      if (r.decision.status !== "executed") continue;
      const qty = Number(r.decision.filled.amount);
      const usd = qty * r.decision.filled.priceUsd;
      const fill = applyFill(book, { assetId: r.decision.filled.asset, side: r.request.side, qty, usd });
      book = fill.book;
      executed.set(r.id, { usd, realizedUsd: r.request.side === "sell" ? fill.realizedUsd : null });
    }
    const rows = all.slice(-100).reverse();
    return c.json({
      activity: rows.map((r) => ({
        executed: executed.get(r.id) ?? null,
        id: r.id,
        at: new Date(r.at).toISOString(),
        side: r.request.side,
        asset: r.request.asset,
        amountUsd: r.request.amountUsd,
        // The agent's reasoning, sealed to the owner: the service cannot read it, the owner's browser opens it.
        sealedReason: r.sealedReason ?? null,
        decision: r.decision,
        note: r.note ?? null,
        pending: Boolean(r.pending),
      })),
    });
  });

  // What Norr asked the custody provider for, so the owner can check it against the approval screen before signing.
  app.get("/owner/v1/vaults/:id/pending", (c) => {
    const v = mine(c.get("owner") as string, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    const human = (id: string, units: string) => {
      const e = deps.registry.byId(id);
      return e ? { amount: unitsToNumber(units, e.decimals), symbol: e.symbol } : { amount: null, symbol: id };
    };
    const pending = deps.ledger.list(v.id).filter((r) => r.pending).map((r) => {
      const p = r.pending!;
      return {
        ledgerId: r.id,
        requestId: p.requestId,
        requestHash: p.requestHash ?? null,
        venue: p.venue,
        sends: { token: p.intended.tokenIn, ...human(p.intended.tokenIn, p.intended.amountIn) },
        receivesAtLeast: { token: p.intended.tokenOut, ...human(p.intended.tokenOut, p.intended.minAmountOut) },
        recipient: p.intended.recipient,
        check: "Approve only if the approval screen shows the same tokens and amount, and the request hash above if it shows one.",
      };
    });
    return c.json({ pending });
  });

  app.post("/owner/v1/vaults/:id/tokens", (c) => {
    const owner = c.get("owner") as string;
    const v = mine(owner, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    const token = tokens.issue(v.id);
    note(owner, "issued an agent token", v.id);
    return c.json({ token, note: "Shown once. Give it only to the agent for this vault." });
  });

  app.delete("/owner/v1/vaults/:id/tokens", (c) => {
    const owner = c.get("owner") as string;
    const v = mine(owner, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    tokens.revoke(v.id);
    note(owner, "revoked all agent tokens", v.id);
    return c.json({ revoked: true });
  });

  app.get("/owner/v1/audit", (c) => {
    const owner = c.get("owner") as string;
    return c.json({ audit: ctx.audit.filter((a) => a.owner === owner).slice(-100).reverse() });
  });

  // Honest status: no TEE attestation exists yet.
  app.get("/owner/v1/verify", (c) =>
    c.json({
      mode: ctx.mock ? "mock" : "live",
      attested: false,
      note: "This service is not running inside a TEE yet, so there is no hardware attestation to show. When it is deployed, this screen will show the attestation quote and the code hash.",
      ...ctx.build,
    }),
  );
}
