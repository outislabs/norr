import { describe, expect, it } from "vitest";
import { RUG, SOL, registry } from "./fixtures";
import { EQUITY_DISCLAIMER, checkEquityEligibility, checkPriceSanity, gateRisk, impliedPriceUsd, levelOf, scoreCryptoRisk } from "./risk";

const r = registry();
const sig = { routable: true, liquidityUsd: 5e6, marketCapUsd: 1e9, ageDays: 900 };

describe("scam shield heuristics", () => {
  it("allowlists majors and stables by CoinGecko id", () => {
    expect(scoreCryptoRisk(r.byId(SOL.assetId)!, { ...sig, liquidityUsd: 1 }).level).toBe("low");
  });

  it("does not trust a look-alike symbol without the trusted id", () => {
    const fake = r.resolve("USDC")!.candidates.find((c) => c.chain === "hood")!;
    expect(scoreCryptoRisk(fake, { routable: true, liquidityUsd: 1000, marketCapUsd: 10_000, ageDays: 1 }).level).toBe("high");
  });

  it("blocks unroutable assets at score 100", () => {
    expect(scoreCryptoRisk(r.byId(RUG.assetId)!, { ...sig, routable: false })).toMatchObject({ score: 100, level: "high" });
  });

  it("scores a fresh, illiquid, tiny token as high with reasons", () => {
    const res = scoreCryptoRisk(r.byId(RUG.assetId)!, { routable: true, liquidityUsd: 4000, marketCapUsd: 50_000, ageDays: 2 });
    expect(res.level).toBe("high");
    expect(res.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("treats unknown signals as a risk (medium)", () => {
    const res = scoreCryptoRisk(r.byId(RUG.assetId)!, { routable: true, liquidityUsd: null, marketCapUsd: null, ageDays: null });
    expect(res.level).toBe("high"); // 25 + 25 + 15 = 65
    expect(scoreCryptoRisk(r.byId(RUG.assetId)!, { routable: true, liquidityUsd: 100_000, marketCapUsd: 5e6, ageDays: 20 }).level).toBe("medium");
  });

  it("reports no risk signals for a healthy unlisted token", () => {
    expect(scoreCryptoRisk(r.byId(RUG.assetId)!, sig)).toMatchObject({ score: 0, level: "low", reasons: ["No risk signals found."] });
  });

  it("level boundaries", () => {
    expect([levelOf(34), levelOf(35), levelOf(64), levelOf(65)]).toEqual(["low", "medium", "medium", "high"]);
  });

  it("gateRisk: high always blocks, medium needs opt-in", () => {
    const medium = { score: 40, level: "medium" as const, reasons: ["x"] };
    const high = { score: 90, level: "high" as const, reasons: ["y"] };
    expect(gateRisk(medium, true)).toBeNull();
    expect(gateRisk(medium, false)).toMatchObject({ code: "SCAM_RISK" });
    expect(gateRisk(high, true)).toMatchObject({ code: "SCAM_RISK" });
    expect(gateRisk(high, true)!.message).toContain("y");
  });
});

describe("equity eligibility and price sanity", () => {
  it("requires owner-confirmed non-US status and shows the disclaimer", () => {
    expect(checkEquityEligibility(true)).toBeNull();
    const b = checkEquityEligibility(false)!;
    expect(b.code).toBe("INELIGIBLE");
    expect(b.message).toContain(EQUITY_DISCLAIMER);
  });

  it("passes quotes within the deviation limit", () => {
    expect(checkPriceSanity(211, impliedPriceUsd(100, 0.4695))).toBeNull(); // about 0.9% off
  });

  it("blocks quotes beyond the limit and when there is no reference", () => {
    expect(checkPriceSanity(211, 230)).toMatchObject({ code: "PRICE_SANITY" });
    expect(checkPriceSanity(null, 211)).toMatchObject({ code: "PRICE_SANITY" });
    expect(checkPriceSanity(211, impliedPriceUsd(100, 0))).toMatchObject({ code: "PRICE_SANITY" });
  });
});
