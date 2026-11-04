import { applyFill, fundingSources, lossToday, sumToday, unitsForUsd, unitsToNumber, usdToUnits, validRefundAddress, type Book, type FundingSource } from "@norr/core";
import type { BuildInfo } from "../build-info";
import type { Attestor } from "../attestation";
import type { SealKeyStore, SealingLedger } from "../seal";
import { FUNDING_WINDOW_MS, FundingTracker, MAX_OPEN_FUNDING, fundingState } from "../funding";
import { CASH_USD } from "../portfolio";
import { Policy } from "@norr/shared";
import type { Hono } from "hono";
import { z } from "zod";
import { valueLayers } from "../portfolio";
import type { AgentTokens } from "../tokens";
import { reconcile, type TradeDeps } from "../trade";
import type { OwnerAuth } from "./auth";
import type { ValueHistory } from "../history";
import { vaultPnl } from "../vault-pnl";
import { assetCheck } from "../asset-check";
import { RateLimiter, type BetaControl } from "../beta";
import { OnboardingError, type Onboarding } from "../onboarding";

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
  /** Dashboard origins allowed to sign in. When set, sign-in must come from one of them and is bound to it. */
  allowedOrigins?: string[];
  attestor?: Attestor | null;
  audit: OwnerAuditEntry[];
  /** Balance readings over time, for the dashboard's value chart. */
  history?: ValueHistory;
  /** Self-serve vaults (public beta). */
  onboarding?: Onboarding;
  beta?: BetaControl;
  limiter?: RateLimiter;
}

/** The vault's holdings across both layers, valued at registry prices. Null when balances cannot be read right now. */
export async function readPortfolio(deps: TradeDeps, v: { walletAccount: string; custody: { confidentialHoldings(): Promise<Record<string, string>> } }) {
  try {
    return valueLayers({ public: deps.balances ? await deps.balances.holdings(v.walletAccount) : undefined, confidential: await v.custody.confidentialHoldings() }, deps.registry);
  } catch {
    return null; // balances unavailable: the rest of the page still works
  }
}

/** Records a reading for the chart (throttled by the store). */
export function sampleValue(deps: TradeDeps, history: ValueHistory | undefined, vaultId: string, p: { totalUsd: number; byClass: { crypto: number; equity: number } } | null): void {
  if (!history || !p) return;
  history.record(vaultId, { t: deps.now(), totalUsd: p.totalUsd, cryptoUsd: p.byClass.crypto, equityUsd: p.byClass.equity });
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
  const limiter = ctx.limiter ?? new RateLimiter(deps.now);
  const onboarding = ctx.onboarding;
  /** An onboarding failure as the plain answer the dashboard shows. */
  const fail = (c: { json: (b: unknown, s: number) => Response }, e: unknown) =>
    e instanceof OnboardingError ? c.json({ error: e.message }, e.status) : c.json({ error: "Something went wrong. Try again in a moment." }, 500);

  // With allowed origins configured, only those dashboards can sign in, and the challenge is bound to the one asking.
  const origins = ctx.allowedOrigins ?? [];
  const signInOrigin = (c: { req: { header(n: string): string | undefined } }): { ok: true; origin?: string } | { ok: false } => {
    if (origins.length === 0) return { ok: true };
    const o = c.req.header("origin");
    return o && origins.includes(o) ? { ok: true, origin: o } : { ok: false };
  };

  app.get("/owner/v1/challenge", (c) => {
    const o = signInOrigin(c);
    return o.ok ? c.json(auth.challenge(o.origin)) : c.json({ error: "origin not allowed" }, 403);
  });

  app.post("/owner/v1/login", async (c) => {
    const parsed = LoginBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "sign-in failed" }, 401);
    const o = signInOrigin(c);
    if (!o.ok) return c.json({ error: "sign-in failed" }, 401);
    const session = await auth.login(parsed.data, o.origin);
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
    if (!limiter.allow(`owner:${session.accountId}`, 300, 60_000)) return c.json({ error: "Too many requests. Wait a minute." }, 429);
    await next();
  });

  const mine = (owner: string, id: string) => {
    const v = deps.vaults.get(id);
    return v && v.owner === owner ? v : undefined;
  };
  const summary = (v: NonNullable<ReturnType<typeof mine>>) => ({
    id: v.id,
    status: "active" as const,
    walletAccount: v.walletAccount,
    policy: v.policy,
    paused: v.policy.paused,
    // Computed now from the vault's day totals, not from the cached copy that only a trade refreshes.
    state: { spentTodayUsd: sumToday(v.spend, deps.now()), realizedLossTodayUsd: lossToday(v.pnl, deps.now()), lastTradeAt: v.state.lastTradeAtMs ? new Date(v.state.lastTradeAtMs).toISOString() : null },
  });

  app.get("/owner/v1/me", (c) => {
    const owner = c.get("owner") as string;
    const setup = onboarding ? onboarding.mine(owner).filter((r) => r.status === "setup").length : 0;
    return c.json({ accountId: owner, vaults: deps.vaults.list().filter((v) => v.owner === owner).length + setup, mock: ctx.mock, selfServe: Boolean(onboarding), beta: ctx.beta?.get() ?? null });
  });

  app.post("/owner/v1/logout", (c) => {
    auth.logout(c.get("ownerToken") as string);
    return c.json({ ok: true });
  });

  app.get("/owner/v1/vaults", (c) => {
    const owner = c.get("owner") as string;
    const setup = onboarding ? onboarding.mine(owner).filter((r) => r.status === "setup").map((r) => onboarding.view(r)) : [];
    return c.json({ vaults: [...deps.vaults.list().filter((v) => v.owner === owner).map(summary), ...setup] });
  });

  // Self-serve vaults (docs/MULTI-USER.md). Create: a custody wallet for this owner, after the terms are accepted.
  app.post("/owner/v1/vaults", async (c) => {
    const owner = c.get("owner") as string;
    if (!onboarding) return c.json({ error: "Creating vaults is not available on this service." }, 404);
    const body = z.object({ acceptTerms: z.string().max(40), nonUsConfirmed: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Accept the terms and risk disclosure first." }, 400);
    if (!limiter.allow(`create:${owner}`, 5, 3_600_000) || !limiter.allow("create:all", 20, 60_000)) return c.json({ error: "Too many new vaults right now. Try again later." }, 429);
    try {
      const rec = await onboarding.create(owner, body.data);
      note(owner, "created a vault (setup)", rec.id);
      return c.json(onboarding.view(rec), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/owner/v1/vaults/:id/setup", (c) => {
    const owner = c.get("owner") as string;
    const r = onboarding?.mine(owner).find((x) => x.id === c.req.param("id"));
    if (!r || !onboarding) return c.json({ error: "not found" }, 404);
    return c.json(onboarding.view(r));
  });

  // The safe default custody policy, and the call the owner's own wallet sends to store it (making the owner controller).
  app.post("/owner/v1/vaults/:id/custody-policy", async (c) => {
    const owner = c.get("owner") as string;
    if (!onboarding) return c.json({ error: "not found" }, 404);
    const body = z.object({ autonomous: z.boolean().default(false) }).safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!body.success) return c.json({ error: "autonomous must be true or false" }, 400);
    if (!limiter.allow(`prepare:${owner}`, 20, 3_600_000)) return c.json({ error: "Too many attempts. Try again later." }, 429);
    try {
      const out = await onboarding.prepare(owner, c.req.param("id"), { autonomous: body.data.autonomous });
      note(owner, `prepared the custody policy${body.data.autonomous ? " (autonomous)" : ""}`, c.req.param("id"));
      return c.json(out);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/owner/v1/vaults/:id/activate", async (c) => {
    const owner = c.get("owner") as string;
    if (!onboarding) return c.json({ error: "not found" }, 404);
    if (!limiter.allow(`activate:${owner}`, 30, 3_600_000)) return c.json({ error: "Too many attempts. Try again later." }, 429);
    try {
      const r = await onboarding.activate(owner, c.req.param("id"));
      if (r.status === "active") note(owner, "activated the vault", c.req.param("id"));
      return c.json(r);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/owner/v1/vaults/:id", async (c) => {
    const v = mine(c.get("owner") as string, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    const portfolio = await readPortfolio(deps, v);
    sampleValue(deps, ctx.history, v.id, portfolio);
    return c.json({ ...summary(v), portfolio });
  });

  // Funding: the owner picks what they hold and on which chain (USDC on NEAR, Base, Solana..., or ETH, SOL), asks for a
  // one-time deposit address on that chain, sends from their own wallet, and watches it arrive as USDC in the vault's
  // confidential balance. The destination is always the vault, set here; the owner only chooses the source and where a
  // refund goes. Nothing here takes a destination from a caller.
  const FundBody = z
    .object({
      amountUsd: z.number().min(1).max(1000).optional(),
      /** Older dashboards send the amount under this name. */
      amountUsdc: z.number().min(1).max(1000).optional(),
      source: z.string().max(200).optional(),
      refundTo: z.string().max(128).optional(),
      fromAccount: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/).optional(),
    })
    .refine((b) => b.amountUsd !== undefined || b.amountUsdc !== undefined);
  const cash = () => deps.quoteAsset;
  const SAFE_ADDRESS = /^[A-Za-z0-9._-]{8,128}$/;
  // What the owner can fund from. Without Norr's own 1Click key only USDC on NEAR (through the custody provider) works.
  const nearCash = (): FundingSource => ({ assetId: cash().id, symbol: cash().symbol, chain: "near", chainName: "NEAR", family: "near", decimals: cash().decimals, contract: null, priceUsd: CASH_USD });
  const sourcesNow = (): FundingSource[] => {
    const live = deps.funder ? fundingSources(deps.registry.entries()) : [];
    return live.some((s) => s.assetId === cash().id) ? live : [nearCash(), ...live];
  };

  app.get("/owner/v1/funding/sources", (c) => c.json({ sources: sourcesNow() }));

  app.post("/owner/v1/vaults/:id/funding", async (c) => {
    const owner = c.get("owner") as string;
    const v = mine(owner, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    const body = FundBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "amountUsd must be a number from 1 to 1000" }, 400);
    const usd = (body.data.amountUsd ?? body.data.amountUsdc)!;
    const src = body.data.source ? sourcesNow().find((s) => s.assetId === body.data.source) : nearCash();
    if (!src) return c.json({ error: "That token and chain are not offered for funding." }, 400);
    const sameAsset = src.assetId === cash().id;
    if (!sameAsset && !deps.funder) return c.json({ error: "Funding from other chains is not available on this service." }, 409);
    const refundTo = src.family === "near" ? (body.data.refundTo?.trim() || body.data.fromAccount || owner) : (body.data.refundTo?.trim() ?? "");
    if (!validRefundAddress(src.family, refundTo)) return c.json({ error: `Enter your ${src.chainName} address, where a refund would go if the deposit cannot complete.` }, 400);
    const now = deps.now();
    if (funding.open(v.id, now).length >= MAX_OPEN_FUNDING) return c.json({ error: "Too many open deposit requests. Use one of them, or wait for them to expire." }, 429);
    const cap = deps.vaultCapUsd?.(v.id);
    if (cap !== undefined) {
      const held = (await readPortfolio(deps, v))?.totalUsd;
      if (held === undefined) return c.json({ error: "Could not read the vault's value, so no address is offered (the beta has a deposit limit). Try again in a moment." }, 503);
      if (held + usd > cap) return c.json({ error: `The beta allows up to $${cap} per vault. This vault holds about $${held.toFixed(2)}, so you can add up to $${Math.max(0, Math.floor(cap - held))}.` }, 400);
    }
    try {
      const baseline = (await v.custody.confidentialHoldings())[cash().id] ?? "0";
      const usdcOut = usdToUnits(usd, CASH_USD, cash().decimals);
      const amount = sameAsset ? usdcOut : unitsForUsd(usd, src.priceUsd, src.decimals);
      // Norr's own 1Click quote is the source (nothing depends on the custody policy); the custody provider is the fallback
      // for USDC on NEAR. Either way the recipient is the vault itself, set here.
      const source = deps.funder ? "1click" : "custody";
      const req = deps.funder
        ? await deps.funder
            .requestDeposit({ token: cash().id, ...(sameAsset ? {} : { originAsset: src.assetId, expectedOut: usdcOut }), amount, recipient: v.walletAccount, refundTo })
            .then((o) => ({ intentId: o.depositAddress, depositAddress: o.depositAddress, amount: o.amountIn, amountFormatted: o.amountInFormatted, minAmountOut: o.minAmountOut }))
        : { ...(await v.custody.requestConfidentialDeposit(cash().id, amount)), amountFormatted: undefined };
      if (!SAFE_ADDRESS.test(req.depositAddress)) return c.json({ error: "The address returned does not look valid, so it is not shown." }, 502);
      const id = `fund-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const expiresAt = now + FUNDING_WINDOW_MS;
      funding.add({ id, vaultId: v.id, token: cash().id, amount: req.amount, minAmount: req.minAmountOut, address: req.depositAddress, intentId: req.intentId, source, baseline, requestedAt: now, expiresAt });
      note(owner, `requested a deposit address for $${usd} from ${src.symbol} on ${src.chainName}`, v.id);
      const sendAmount = req.amountFormatted ?? String(unitsToNumber(req.amount, src.decimals));
      return c.json({
        id,
        address: req.depositAddress,
        amountUsd: usd,
        amountUsdc: usd,
        /** The least that counts as arrived, in USDC, from the quote. */
        minArrivingUsdc: unitsToNumber(req.minAmountOut, cash().decimals),
        send: { amount: sendAmount, units: req.amount, symbol: src.symbol, chain: src.chain, chainName: src.chainName, family: src.family, ...(src.evmChainId ? { evmChainId: src.evmChainId } : {}), contract: src.contract, decimals: src.decimals },
        asset: { symbol: src.symbol, chain: src.chainName, contract: src.contract ?? cash().id.replace(/^nep141:/, "") },
        refundTo,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    } catch (e) {
      // The custody provider gates this request by transaction type ("call"). Say so, rather than a vague failure.
      if (e instanceof Error && /not allowed by policy/i.test(e.message)) {
        return c.json({ error: "Your custody policy does not allow deposit-address requests (transaction type \"call\"). Allow it in your custody dashboard while you fund this vault, then remove it again." }, 409);
      }
      if (e instanceof Error && /refundTo is not valid/i.test(e.message)) return c.json({ error: `1Click did not accept that ${src.chainName} address for refunds. Check it and try again.` }, 400);
      if (e instanceof Error && /(lose more than|below the listed price|no USD values)/.test(e.message)) return c.json({ error: "The route for that amount costs too much right now, so no address is offered. Try USDC, or a larger amount." }, 502);
      return c.json({ error: "Could not get a deposit address. Try again in a moment." }, 503);
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

  // The same verdict the agent gets from check_asset, for the dashboard's Check a token.
  app.get("/owner/v1/vaults/:id/assets/check", async (c) => {
    const v = mine(c.get("owner") as string, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    const q = c.req.query("asset")?.trim();
    if (!q) return c.json({ error: "asset is required" }, 400);
    return c.json(await assetCheck(deps, q, v.policy.nonUsConfirmed));
  });

  app.get("/owner/v1/vaults/:id/pnl", (c) => {
    const v = mine(c.get("owner") as string, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    return c.json(vaultPnl(deps, v.id));
  });

  // The owner sees the agent's stated reasoning; nobody else does.
  app.get("/owner/v1/vaults/:id/activity", async (c) => {
    const v = mine(c.get("owner") as string, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    for (const row of deps.ledger.list(v.id).filter((r) => r.pending).slice(0, 5)) await reconcile(deps, row.id).catch(() => null);
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
  app.get("/owner/v1/vaults/:id/pending", async (c) => {
    const v = mine(c.get("owner") as string, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    // Settle swaps the owner has approved (or rejected) since, so they leave this list.
    for (const row of deps.ledger.list(v.id).filter((r) => r.pending).slice(0, 5)) await reconcile(deps, row.id).catch(() => null);
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
        // Norr's own record, in the custody provider's units, for the browser's side-by-side check.
        intended: { tokenIn: p.intended.tokenIn, amountIn: p.intended.amountIn, tokenOut: p.intended.tokenOut, minAmountOut: p.intended.minAmountOut },
        approvalId: null as string | null,
        check: "Approve only if the approval screen shows the same tokens and amount, and the request hash above if it shows one.",
      };
    });
    // The provider's approval ids, matched to Norr's records by request id. An approval Norr did not ask for is listed
    // separately: the dashboard offers only Reject for it. Listing needs the wallet key; voting never goes through Norr.
    let unknown: { approvalId: string; requestId: string | null; type: string; expiresAt: string }[] = [];
    let approvalsListed = false;
    if (v.custody.pendingApprovals) {
      try {
        const approvals = await v.custody.pendingApprovals();
        approvalsListed = true;
        for (const a of approvals) {
          const mine = pending.find((p) => p.requestId === a.requestId);
          if (mine) mine.approvalId = a.approvalId;
          else unknown.push(a);
        }
      } catch {
        unknown = [];
      }
    }
    // Where the browser fetches each approval and sends the owner's signed vote: the provider itself, so Norr can
    // neither change what is shown nor what is signed. In mock mode, the service's stand-in for it.
    const approvalsApi = ctx.mock ? "service:/mock-outlayer" : "https://api.outlayer.ai";
    return c.json({ pending, unknown, approvalsListed, approvalsApi, voteRecipient: "outlayer.near" });
  });

  app.get("/owner/v1/vaults/:id/tokens", (c) => {
    const v = mine(c.get("owner") as string, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    return c.json({ tokens: tokens.list(v.id) });
  });

  app.delete("/owner/v1/vaults/:id/tokens/:tid", (c) => {
    const owner = c.get("owner") as string;
    const v = mine(owner, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    if (!tokens.revokeOne(v.id, c.req.param("tid"))) return c.json({ error: "not found" }, 404);
    note(owner, "revoked an agent token", v.id);
    return c.json({ revoked: true });
  });

  app.post("/owner/v1/vaults/:id/tokens", async (c) => {
    const owner = c.get("owner") as string;
    const v = mine(owner, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown } | null;
    const label = typeof body?.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : "Agent token";
    const token = tokens.issue(v.id, { label, kind: "token" });
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

  app.get("/owner/v1/vaults/:id/history", (c) => {
    const v = mine(c.get("owner") as string, c.req.param("id"));
    if (!v) return c.json({ error: "not found" }, 404);
    return c.json({ points: ctx.history?.list(v.id) ?? [] });
  });

  // What the status bar shows. Nothing here is secret: it says whether the service can trade right now and why not.
  app.get("/owner/v1/status", async (c) => {
    const owner = c.get("owner") as string;
    const mine_ = deps.vaults.list().filter((v) => v.owner === owner);
    const feedConfigured = (deps.incidentFeed ?? "active") === "active";
    const feed = feedConfigured ? await deps.shield().catch(() => null) : null;
    return c.json({
      mock: ctx.mock,
      pricing: deps.pricingReady?.() === false ? "retrying" : "ready",
      shield: !feedConfigured ? "not_configured" : feed === null ? "unavailable" : feed.status === "operational" ? "ok" : "incidents",
      enclave: Boolean(ctx.attestor),
      vaults: { total: mine_.length, paused: mine_.filter((v) => v.policy.paused).length },
    });
  });

  app.get("/owner/v1/audit", (c) => {
    const owner = c.get("owner") as string;
    return c.json({ audit: ctx.audit.filter((a) => a.owner === owner).slice(-100).reverse() });
  });

  // `attested` only says the service has a TEE to ask. It proves nothing: the dashboard fetches the evidence and
  // checks it itself (packages/shared/src/attestation.ts), and so can anyone else.
  app.get("/owner/v1/verify", (c) =>
    c.json({
      mode: ctx.mock ? "mock" : "live",
      attested: Boolean(ctx.attestor),
      note: ctx.attestor
        ? "This service is running in a TEE and can produce an attestation. Do not take this label on trust: run the checks below, which your browser performs on the evidence itself."
        : "This service is not running inside a TEE, so there is no hardware attestation to show.",
      ...ctx.build,
    }),
  );
}
