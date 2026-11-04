import { EQUITY_DISCLAIMER, equityMinimum, incidentFeedInfo, MINIMUMS_NOTE, sumToday, unitsToNumber, type IncidentFeedStatus } from "@norr/core";
import { TradeInput, type Decision, type TradeRequest } from "@norr/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolveBuildInfo, type BuildInfo } from "./build-info";
import { vaultPnl } from "./vault-pnl";
import { assetCheck } from "./asset-check";
import { rateLimiter, type Attestor } from "./attestation";
import type { SealKeyStore, SealingLedger } from "./seal";
import { mountOwnerRoutes, type OwnerAuditEntry } from "./owner/routes";
import type { OwnerAuth } from "./owner/auth";
import type { ValueHistory } from "./history";
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
  /** Where owners enroll the key their private reasoning is sealed to. Needed for the owner API's reasoning endpoints. */
  seal?: { keys: SealKeyStore; ledger: SealingLedger };
  /** Dashboard origins (for example https://app.norr.finance). Enables CORS for the owner API from exactly these and binds sign-in to them. */
  allowedOrigins?: string[];
  /** The TEE this service runs in, if any. Enables the public /attestation and /info endpoints. */
  attestor?: Attestor | null;
  /** Balance readings over time (owner dashboard chart). */
  history?: ValueHistory;
}

type Env = { Variables: { vaultId: string } };

/**
 * The agent-facing API. There is deliberately no route that moves funds out, changes policy, or
 * accepts a destination. The vault always comes from the agent token. Request bodies are never logged.
 */
export function createApp({ deps, tokens, mock, adminToken, owner, build, seal, allowedOrigins, attestor, history }: AppOptions): Hono<Env> {
  const app = new Hono<Env>();

  // CORS for the separately hosted dashboard: the owner API answers browsers on exactly the configured origins and
  // nobody else. The agent API (/v1) is never opened to browsers. Sessions travel as a bearer header, not a cookie,
  // so no credentials are shared across origins.
  if (allowedOrigins && allowedOrigins.length > 0) {
    app.use("/owner/v1/*", cors({ origin: (o) => (allowedOrigins.includes(o) ? o : null), allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], maxAge: 600 }));
  }
  app.use("/health", cors({ origin: "*", allowMethods: ["GET"] })); // reveals nothing the dashboard does not need to know the service is up

  // Public attestation: anyone can ask the running service to prove what it is, and check the answer themselves
  // (packages/shared/src/attestation.ts, the Verify screen, scripts/verify-attestation.mts). Nothing here is secret.
  const build0 = build ?? resolveBuildInfo();
  const quotaOk = rateLimiter(20, 60_000, deps.now);
  app.use("/attestation", cors({ origin: "*", allowMethods: ["GET"] }));
  app.use("/info", cors({ origin: "*", allowMethods: ["GET"] }));
  app.get("/attestation", async (c) => {
    if (!attestor) return c.json({ attested: false, error: "This service is not running in a TEE: there is no attestation device to ask." }, 503);
    const nonce = c.req.query("nonce") ?? "";
    if (!/^[0-9a-f]{2,128}$/i.test(nonce) || nonce.length % 2 !== 0) return c.json({ error: "nonce must be 1 to 64 bytes of hex" }, 400);
    if (!quotaOk()) return c.json({ error: "too many attestation requests; try again in a minute" }, 429);
    try {
      return c.json({ attested: true, nonce: nonce.toLowerCase(), ...(await attestor.evidence(nonce.toLowerCase())), commit: build0.commit });
    } catch {
      return c.json({ attested: false, error: "The TEE did not produce a quote." }, 502);
    }
  });
  app.get("/info", async (c) => {
    if (!attestor) return c.json({ attested: false, error: "This service is not running in a TEE: there is no attestation device to ask." }, 503);
    try {
      return c.json({ attested: true, ...(await attestor.info()), commit: build0.commit });
    } catch {
      return c.json({ attested: false, error: "The TEE did not return its configuration." }, 502);
    }
  });

  // In mock mode the demo owner is public, so the dashboard can offer a one-click demo sign-in.
  // The incident feed's status is a deployment setting (a partner key is configured or not), reported on every answer.
  const feedStatus = (): IncidentFeedStatus => deps.incidentFeed ?? "active";
  const feedInfo = () => incidentFeedInfo(feedStatus());
  app.get("/health", (c) => c.json({ ok: true, mock, pricing: deps.pricingReady?.() === false ? "retrying" : "ready", incidentFeed: feedStatus(), ...(mock ? { mockOwner: deps.vaults.list()[0]?.owner } : {}) }));

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
    if (deps.pricingReady?.() === false) out.notice = "The asset list is not loaded yet (the market data service was unreachable at startup). Norr is retrying; trades are blocked until it loads.";
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
    return c.json(await assetCheck(deps, q, vault.policy.nonUsConfirmed));
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
    if ("decision" in planned) return c.json({ ...planned.decision, incidentFeed: feedInfo() });
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
      incidentFeed: feedInfo(),
    });
  });

  app.post("/v1/trade", async (c) => {
    const request = await parseTrade(c, c.get("vaultId"));
    if (!request) return c.json({ error: "invalid request" }, 400);
    const decision: Decision = await executeTrade(deps, request);
    return c.json({ ...decision, incidentFeed: feedInfo() });
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
      incidentFeed: feedInfo(),
    });
  });

  app.get("/v1/pnl", (c) => c.json(vaultPnl(deps, c.get("vaultId"))));

  // Market data for one asset: the listed price (1Click's token list) and, for crypto, the read-only signals Scam Shield
  // scores (liquidity, market cap, age) with its verdict. Numbers only; Norr does not recommend trades.
  app.get("/v1/market", async (c) => {
    const q = c.req.query("asset");
    if (!q) return c.json({ error: "asset is required" }, 400);
    const res = deps.registry.resolve(q);
    if (!res) return c.json({ found: false, message: `"${q}" is not a tradable asset.` });
    const versions = await Promise.all(
      res.candidates.map(async (e) => {
        const base = { symbol: e.symbol, issuer: e.issuer, chain: e.chain, id: e.id, priceUsd: e.priceUsd };
        if (res.class === "equity") return { ...base, minimumUsd: equityMinimum(res.ticker).usd };
        const signals = await deps.marketSignals?.(e).catch(() => null);
        const risk = await deps.risk.assess(e).catch(() => null);
        return { ...base, liquidityUsd: signals?.liquidityUsd ?? null, marketCapUsd: signals?.marketCapUsd ?? null, ageDays: signals?.ageDays ?? null, routable: signals?.routable ?? null, risk: risk ? { level: risk.level, score: risk.score } : null, contract: risk?.contract ?? null };
      }),
    );
    return c.json({ found: true, class: res.class, ticker: res.ticker, versions, incidentFeed: feedInfo(), source: res.class === "crypto" ? "Price: NEAR Intents token list. Liquidity, market cap and age: DexScreener (read-only). Contract checks: GoPlus Security (read-only). Both as scored by Scam Shield." : "Price: NEAR Intents token list." });
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

  if (owner) mountOwnerRoutes(app, { deps, tokens, auth: owner, mock, build: build ?? resolveBuildInfo(), seal, allowedOrigins, attestor: attestor ?? null, audit: [] as OwnerAuditEntry[], history });

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
