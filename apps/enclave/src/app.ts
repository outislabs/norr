import { checkShield, EQUITY_DISCLAIMER, equityMinimum, MINIMUMS_NOTE, sumToday, unitsToNumber, type RiskResult } from "@norr/core";
import { TradeInput, type Decision, type TradeRequest } from "@norr/shared";
import { Hono } from "hono";
import { resolveBuildInfo, type BuildInfo } from "./build-info";
import { mountOwnerRoutes, type OwnerAuditEntry } from "./owner/routes";
import type { OwnerAuth } from "./owner/auth";
import { valueLayers } from "./portfolio";
import { safeEqual, type AgentTokens } from "./tokens";
import { executeTrade, planTrade, reconcile, type TradeDeps } from "./trade";

export interface AppOptions {
  deps: TradeDeps;
  tokens: AgentTokens;
  mock: boolean;
  /** Development-only owner controls (pause/resume). Disabled when unset. Replaced by NEAR-signed owner sessions with the dashboard. */
  adminToken?: string;
  /** Wallet sign-in for the dashboard. When set, the owner API is mounted under /owner/v1. */
  owner?: OwnerAuth;
  /** Code version for the Verify screen; defaults to the local git checkout. */
  build?: BuildInfo;
}

type Env = { Variables: { vaultId: string } };

/**
 * The agent-facing API. There is deliberately no route that moves funds out, changes policy, or
 * accepts a destination. The vault always comes from the agent token. Request bodies are never logged.
 */
export function createApp({ deps, tokens, mock, adminToken, owner, build }: AppOptions): Hono<Env> {
  const app = new Hono<Env>();

  // In mock mode the demo owner is public, so the dashboard can offer a one-click demo sign-in.
  app.get("/health", (c) => c.json({ ok: true, mock, ...(mock ? { mockOwner: deps.vaults.list()[0]?.owner } : {}) }));

  app.use("/v1/*", async (c, next) => {
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    const vaultId = m?.[1] ? tokens.vaultFor(m[1]) : undefined;
    if (!vaultId || !deps.vaults.get(vaultId)) return c.json({ error: "unauthorized" }, 401);
    c.set("vaultId", vaultId);
    await next();
  });

  app.get("/v1/assets", (c) => {
    const cls = c.req.query("class");
    if (cls !== undefined && cls !== "crypto" && cls !== "equity") return c.json({ error: "class must be crypto or equity" }, 400);
    const out: Record<string, unknown> = {};
    if (cls !== "equity") {
      out.crypto = deps.registry.entries("crypto").map((e) => ({ symbol: e.symbol, chain: e.chain, id: e.id }));
    }
    if (cls !== "crypto") {
      const byTicker = new Map<string, { issuer: string | null; symbol: string; id: string }[]>();
      for (const e of deps.registry.entries("equity")) {
        byTicker.set(e.ticker, [...(byTicker.get(e.ticker) ?? []), { issuer: e.issuer, symbol: e.symbol, id: e.id }]);
      }
      out.equities = [...byTicker].map(([ticker, issuers]) => ({ ticker, minimumUsd: equityMinimum(ticker).usd, issuers }));
      out.equityNotice = EQUITY_DISCLAIMER;
      out.equityMinimumNote = MINIMUMS_NOTE;
    }
    return c.json(out);
  });

  app.get("/v1/assets/check", async (c) => {
    const vault = deps.vaults.get(c.get("vaultId"))!;
    const q = c.req.query("asset");
    if (!q) return c.json({ error: "asset is required" }, 400);
    const res = deps.registry.resolve(q);
    if (!res) return c.json({ found: false, message: `"${q}" is not a tradable asset.` });
    const feed = await deps.shield().catch(() => null);
    const versions = await Promise.all(
      res.candidates.map(async (e) => {
        const shield = checkShield(feed, e);
        const risk: RiskResult | null = res.class === "crypto" ? await deps.risk.assess(e) : null;
        return { symbol: e.symbol, issuer: e.issuer, chain: e.chain, shieldBlocked: shield?.message ?? null, risk };
      }),
    );
    return c.json({
      found: true,
      class: res.class,
      ticker: res.ticker,
      versions,
      ...(res.class === "equity" ? { eligible: vault.policy.nonUsConfirmed, notice: EQUITY_DISCLAIMER } : {}),
    });
  });

  const parseTrade = async (c: { req: { json(): Promise<unknown> } }, vaultId: string): Promise<TradeRequest | null> => {
    const body = await c.req.json().catch(() => null);
    const parsed = TradeInput.safeParse(body);
    return parsed.success ? { ...parsed.data, vaultId } : null;
  };

  app.post("/v1/quote", async (c) => {
    const vault = deps.vaults.get(c.get("vaultId"))!;
    const request = await parseTrade(c, vault.id);
    if (!request) return c.json({ error: "invalid request" }, 400);
    const planned = await planTrade(deps, vault, request);
    if ("decision" in planned) return c.json(planned.decision);
    const { plan } = planned;
    const out = plan.side === "buy" ? plan.candidate : deps.quoteAsset;
    return c.json({
      status: "quote",
      note: "Dry run. No funds move.",
      asset: plan.candidate.symbol,
      side: plan.side,
      amountUsd: request.amountUsd,
      estimatedOut: unitsToNumber(plan.quote.amountOut, out.decimals),
      minimumOut: unitsToNumber(plan.quote.minAmountOut, out.decimals),
      outAsset: out.symbol,
      venue: plan.venue,
      ...(plan.candidate.class === "equity" ? { statedMinimumUsd: equityMinimum(plan.candidate.ticker).usd } : {}),
      ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
    });
  });

  app.post("/v1/trade", async (c) => {
    const request = await parseTrade(c, c.get("vaultId"));
    if (!request) return c.json({ error: "invalid request" }, 400);
    const decision: Decision = await executeTrade(deps, request);
    return c.json(decision);
  });

  app.get("/v1/portfolio", async (c) => {
    const vault = deps.vaults.get(c.get("vaultId"))!;
    try {
      const layers = {
        public: deps.balances ? await deps.balances.holdings(vault.walletAccount) : undefined,
        confidential: await vault.custody.confidentialHoldings(),
      };
      return c.json(valueLayers(layers, deps.registry, [deps.quoteAsset.id]));
    } catch {
      return c.json({ error: "balances unavailable" }, 503);
    }
  });

  app.get("/v1/policy", (c) => {
    const v = deps.vaults.get(c.get("vaultId"))!;
    const p = v.policy;
    const spent = sumToday(v.spend, deps.now());
    return c.json({
      maxTradeUsd: p.maxTradeUsd,
      dailySpendCapUsd: p.dailySpendCapUsd,
      spentTodayUsd: Number(spent.toFixed(2)),
      spendRemainingTodayUsd: Number(Math.max(0, p.dailySpendCapUsd - spent).toFixed(2)),
      dailyLossCapUsd: p.dailyLossCapUsd,
      maxEquityPct: p.maxEquityPct,
      allowedCrypto: p.allowedCrypto,
      allowedEquities: p.allowedEquities,
      cooldownSec: p.cooldownSec,
      allowMediumRisk: p.allowMediumRisk,
      equitiesEnabled: p.nonUsConfirmed,
      privacy: p.privacy,
      paused: p.paused,
    });
  });

  app.get("/v1/activity", async (c) => {
    const vaultId = c.get("vaultId");
    // Settle swaps that were waiting for the owner, so the agent sees their final result.
    for (const row of deps.ledger.list(vaultId).filter((r) => r.pending).slice(0, 5)) await reconcile(deps, row.id);
    const rows = deps.ledger.list(vaultId).slice(-20).reverse();
    return c.json({
      activity: rows.map((r) => ({ at: new Date(r.at).toISOString(), side: r.request.side, asset: r.request.asset, amountUsd: r.request.amountUsd, decision: r.decision })),
    });
  });

  if (owner) mountOwnerRoutes(app, { deps, tokens, auth: owner, mock, build: build ?? resolveBuildInfo(), audit: [] as OwnerAuditEntry[] });

  if (adminToken) {
    const admin = (c: { req: { header(n: string): string | undefined } }) => safeEqual(c.req.header("x-admin-token") ?? "", adminToken);
    app.post("/owner/vaults/:id/pause", (c) => {
      if (!admin(c)) return c.json({ error: "unauthorized" }, 401);
      deps.vaults.pause(c.req.param("id"), "paused by owner");
      return c.json({ ok: true });
    });
    app.post("/owner/vaults/:id/resume", (c) => {
      if (!admin(c)) return c.json({ error: "unauthorized" }, 401);
      deps.vaults.resume(c.req.param("id"));
      return c.json({ ok: true });
    });
  }

  app.onError((_e, c) => c.json({ error: "internal error" }, 500));
  return app;
}
