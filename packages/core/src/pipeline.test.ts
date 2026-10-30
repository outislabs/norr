import { BlockCode } from "@norr/shared";
import { describe, expect, it } from "vitest";
import { NVDA_ON, NVDA_X, RUG, USDC_FAKE, policy, registry, request, riskProvider, state } from "./fixtures";
import { isBlock, noLiquidity, preTradeChecks, type PreTradeInput } from "./pipeline";
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

  it("prefers the safe version when a look-alike symbol survives the risk gate", async () => {
    const r = await preTradeChecks(base({ request: request({ asset: "USDC", amountUsd: 5 }), policy: policy({ allowMediumRisk: true }) }));
    expect(isBlock(r)).toBe(false);
    if (!isBlock(r)) expect(r.candidates.map((c) => c.id)).not.toContain(USDC_FAKE.assetId);
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
  ["DAILY_LOSS_CAP", () => preTradeChecks(base({ state: state({ realizedLossTodayUsd: 99 }) }))],
  ["COOLDOWN", () => preTradeChecks(base({ policy: policy({ cooldownSec: 60 }), state: state({ lastTradeAtMs: 999_000 }) }))],
  ["ASSET_NOT_ALLOWED", () => preTradeChecks(base({ policy: policy({ allowedEquities: ["TSLA"] }) }))],
  ["EQUITY_LIMIT", () => preTradeChecks(base({ policy: policy({ maxEquityPct: 1 }) }))],
  ["SCAM_RISK", () => preTradeChecks(base({ request: request({ asset: RUG.symbol, amountUsd: 5 }) }))],
  ["INELIGIBLE", () => preTradeChecks(base({ policy: policy({ nonUsConfirmed: false }) }))],
  ["PRICE_SANITY", async () => checkPriceSanity(211, 260)],
  ["UNKNOWN_ASSET", () => preTradeChecks(base({ request: request({ asset: "NOPE" }) }))],
  ["NO_LIQUIDITY", async () => noLiquidity()],
  ["SHIELD_INCIDENT", () => preTradeChecks(base({ shield: null }))],
];

describe("every block code is reachable", () => {
  for (const [code, run] of cases) {
    it(code, async () => expect(await run()).toMatchObject({ ok: false, code }));
  }

  it("covers all of BlockCode, so a new code without a test fails here", () => {
    expect(cases.map(([c]) => c).sort()).toEqual([...BlockCode.options].sort());
  });
});
