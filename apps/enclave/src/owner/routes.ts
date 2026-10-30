import { unitsToNumber } from "@norr/core";
import type { BuildInfo } from "../build-info";
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
    state: { spentTodayUsd: v.state.spentTodayUsd, realizedLossTodayUsd: v.state.realizedLossTodayUsd, lastTradeAt: v.state.lastTradeAtMs ? new Date(v.state.lastTradeAtMs).toISOString() : null },
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
    const rows = deps.ledger.list(v.id).slice(-100).reverse();
    return c.json({
      activity: rows.map((r) => ({
        id: r.id,
        at: new Date(r.at).toISOString(),
        side: r.request.side,
        asset: r.request.asset,
        amountUsd: r.request.amountUsd,
        reason: r.request.reason,
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
