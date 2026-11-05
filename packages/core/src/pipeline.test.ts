import { BlockCode } from "@norr/shared";
import { describe, expect, it } from "vitest";
import { NVDA_ON, NVDA_X, RUG, USDC_FAKE, USDC_NEAR, policy, registry, request, riskProvider, state } from "./fixtures";
import { ambiguousAsset, isBlock, noLiquidity, preTradeChecks, pricingUnavailable, privacyUnavailable, vaultCapReached, type PreTradeInput } from "./pipeline";
import { checkPriceSanity } from "./risk";

const base = (over: Partial<PreTradeInput> = {}): PreTradeInput => ({
  request: request(), policy: policy(), state: state(), registry: registry(), risk: riskProvider(),
  shield: { status: "operational" }, nowMs: 1_000_000, ...over,
});

describe("preTradeChecks", () => {
  it("passes an NVDA buy with both issuers as candidates", async () => {
    const r = await preTradeChecks(base());
    expect(isBlock(r)).toBe(false);
    if (!isBlock(r)) expect(r.candidates.map((c) => c.id).sort()).toEqual([NVDA_ON.assetId, NVDA_X.assetId].sort());
  });

  it("drops a shielded issuer but keeps routing through the other", async () => {
    const shield = { status: "incidents" as const, incidents: [{ scopeType: "chain" as const, scopeValue: "sol" }] };
    const r = await preTradeChecks(base({ shield }));
    expect(isBlock(r)).toBe(false);
    if (!isBlock(r)) expect(r.candidates.map((c) => c.id)).toEqual([NVDA_ON.assetId]);
  });

  it("a symbol shared by different tokens (a look-alike) is refused until the exact token is named; the exact one trades", async () => {
    const r = await preTradeChecks(base({ request: request({ asset: "USDC", amountUsd: 5 }), policy: policy({ allowMediumRisk: true }) }));
    expect(r).toMatchObject({ code: "AMBIGUOUS_ASSET" });
    expect((r as { message: string }).message).toContain(USDC_FAKE.assetId);
    const exact = await preTradeChecks(base({ request: request({ asset: USDC_NEAR.assetId, amountUsd: 5 }), policy: policy({ allowMediumRisk: true }) }));
    expect(isBlock(exact)).toBe(false);
    if (!isBlock(exact)) expect(exact.candidates.map((c) => c.id)).toEqual([USDC_NEAR.assetId]);
  });

  describe("order: the vault's rules and scam risk come before the incident feed", () => {
    const down = { shield: null }; // the feed cannot be read: fail closed
    const incidentOnSol = { shield: { status: "incidents" as const, incidents: [{ scopeType: "chain" as const, scopeValue: "sol" }] } };

    it("a trade over the limit is refused for the limit, even when the feed is down", async () => {
      expect(await preTradeChecks(base({ ...down, policy: policy({ maxTradeUsd: 50 }), request: request({ asset: "TSLA", amountUsd: 150 }) }))).toMatchObject({ code: "OVER_TRADE_LIMIT" });
    });

    it("an asset outside the allowlist is refused for the allowlist, even with an active incident on it", async () => {
      expect(await preTradeChecks(base({ ...incidentOnSol, policy: policy({ allowedCrypto: ["USDC"] }), request: request({ asset: "SOL", amountUsd: 5 }) }))).toMatchObject({ code: "ASSET_NOT_ALLOWED" });
    });

    it("a high-risk token is refused for scam risk, even when the feed is down", async () => {
      expect(await preTradeChecks(base({ ...down, request: request({ asset: "RUGCOIN", amountUsd: 5 }) }))).toMatchObject({ code: "SCAM_RISK" });
    });

    it("the daily spending cap and the cooldown are reported before the feed", async () => {
      const spent = await preTradeChecks(base({ ...down, policy: policy({ dailySpendCapUsd: 50 }), state: state({ spentTodayUsd: 45 }), request: request({ asset: "SOL", amountUsd: 10 }) }));
      expect(spent).toMatchObject({ code: "DAILY_SPEND_CAP" });
      const soon = await preTradeChecks(base({ ...down, policy: policy({ cooldownSec: 60 }), state: state({ lastTradeAtMs: 990_000 }), request: request({ asset: "SOL", amountUsd: 5 }) }));
      expect(soon).toMatchObject({ code: "COOLDOWN" });
    });

    it("a trade that passes every rule is still blocked when the feed is down (fail closed), or when an incident touches it", async () => {
      expect(await preTradeChecks(base({ ...down, request: request({ asset: "SOL", amountUsd: 5 }) }))).toMatchObject({ code: "SHIELD_INCIDENT" });
      expect(await preTradeChecks(base({ ...incidentOnSol, request: request({ asset: "SOL", amountUsd: 5 }) }))).toMatchObject({ code: "SHIELD_INCIDENT" });
    });

    it("with no feed configured on the deployment, rule-abiding trades pass and every rule and scam check still applies", async () => {
      const off = { shield: null, incidentFeed: "not_configured" as const };
      expect(isBlock(await preTradeChecks(base({ ...off, request: request({ asset: "SOL", amountUsd: 5 }) })))).toBe(false);
      expect(await preTradeChecks(base({ ...off, policy: policy({ maxTradeUsd: 50 }), request: request({ asset: "TSLA", amountUsd: 150 }) }))).toMatchObject({ code: "OVER_TRADE_LIMIT" });
      expect(await preTradeChecks(base({ ...off, request: request({ asset: "RUGCOIN", amountUsd: 5 }) }))).toMatchObject({ code: "SCAM_RISK" });
      // A configured feed that cannot be read still fails closed.
      expect(await preTradeChecks(base({ shield: null, incidentFeed: "active", request: request({ asset: "SOL", amountUsd: 5 }) }))).toMatchObject({ code: "SHIELD_INCIDENT" });
    });

    it("the owner's explicit dev bypass still lets a rule-abiding trade through when the feed is down", async () => {
      expect(isBlock(await preTradeChecks(base({ ...down, shieldOnUnavailable: "allow", request: request({ asset: "SOL", amountUsd: 5 }) })))).toBe(false);
    });
  });

  it("lets the agent's demo flow through: $40 NVDA ok, $150 TSLA blocked, $5 rug blocked, $5 SOL ok", async () => {
    const p = policy({ maxTradeUsd: 50 });
    expect(isBlock(await preTradeChecks(base({ policy: p })))).toBe(false);
    expect(await preTradeChecks(base({ policy: p, request: request({ asset: "TSLA", amountUsd: 150 }) }))).toMatchObject({ code: "OVER_TRADE_LIMIT" });
    const rug = await preTradeChecks(base({ policy: p, request: request({ asset: "RUGCOIN", amountUsd: 5 }) }));
    expect(rug).toMatchObject({ code: "SCAM_RISK" });
    expect(isBlock(await preTradeChecks(base({ policy: p, request: request({ asset: "SOL", amountUsd: 5 }) })))).toBe(false);
  });

  it("a paused vault does no registry or Shield work", async () => {
    const r = await preTradeChecks(base({ policy: policy({ paused: true }), shield: null, request: request({ asset: "NOPE" }) }));
    expect(r).toMatchObject({ code: "PAUSED" });
  });
});

/** One row per block code. The coverage test below keeps this honest. */
const cases: [string, () => Promise<unknown>][] = [
  ["PAUSED", () => preTradeChecks(base({ policy: policy({ paused: true }) }))],
  ["OVER_TRADE_LIMIT", () => preTradeChecks(base({ request: request({ amountUsd: 500 }) }))],
  ["DAILY_SPEND_CAP", () => preTradeChecks(base({ policy: policy({ dailySpendCapUsd: 500 }), state: state({ spentTodayUsd: 480 }) }))],
  ["DAILY_LOSS_CAP", () => preTradeChecks(base({ state: state({ realizedLossTodayUsd: 99 }) }))],
  ["COOLDOWN", () => preTradeChecks(base({ policy: policy({ cooldownSec: 60 }), state: state({ lastTradeAtMs: 999_000 }) }))],
  ["ASSET_NOT_ALLOWED", () => preTradeChecks(base({ policy: policy({ allowedEquities: ["TSLA"] }) }))],
  ["EQUITY_LIMIT", () => preTradeChecks(base({ policy: policy({ maxEquityPct: 1 }) }))],
  ["SCAM_RISK", () => preTradeChecks(base({ request: request({ asset: RUG.symbol, amountUsd: 5 }) }))],
  ["INELIGIBLE", () => preTradeChecks(base({ policy: policy({ nonUsConfirmed: false }) }))],
  ["PRICE_SANITY", async () => checkPriceSanity(211, 260)],
  ["UNKNOWN_ASSET", () => preTradeChecks(base({ request: request({ asset: "NOPE" }) }))],
  ["NO_LIQUIDITY", async () => noLiquidity()],
  ["PRIVACY_UNAVAILABLE", async () => privacyUnavailable("the vault holds no confidential funds.")],
  ["SHIELD_INCIDENT", () => preTradeChecks(base({ shield: null }))],
  ["PRICING_UNAVAILABLE", async () => pricingUnavailable()],
  ["VAULT_CAP", async () => vaultCapReached(120, 100)],
  ["AMBIGUOUS_ASSET", async () => ambiguousAsset("kat", [{ chain: "near", contractAddress: "kat.token0.near", id: "a" }, { chain: "sol", contractAddress: "6UtY9iTZ", id: "b" }])],
];

describe("every block code is reachable", () => {
  for (const [code, run] of cases) {
    it(code, async () => expect(await run()).toMatchObject({ ok: false, code }));
  }

  it("covers all of BlockCode, so a new code without a test fails here", () => {
    expect(cases.map(([c]) => c).sort()).toEqual([...BlockCode.options].sort());
  });
});

describe("every block gives the agent a usable reason", () => {
  for (const [code, run] of cases) {
    it(`${code} has a plain-language message`, async () => {
      const r = (await run()) as { message: string };
      expect(r.message.length).toBeGreaterThan(25);
      expect(r.message).not.toMatch(/undefined|NaN|\[object/);
    });
  }
});
