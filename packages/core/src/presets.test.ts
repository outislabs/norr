import { Policy } from "@norr/shared";
import { describe, expect, it } from "vitest";
import { presetPolicy, type PresetName } from "./presets";

const names: PresetName[] = ["cautious", "balanced", "degen"];

describe("policy presets", () => {
  for (const n of names) {
    it(`${n} is a valid policy and never pre-confirms non-US status or starts paused`, () => {
      const p = presetPolicy(n, "v1");
      expect(Policy.safeParse(p).success).toBe(true);
      expect(p.nonUsConfirmed).toBe(false);
      expect(p.paused).toBe(false);
      expect(p.vaultId).toBe("v1");
    });
  }

  it("are ordered by risk appetite", () => {
    const [c, b, d] = names.map((n) => presetPolicy(n, "v"));
    expect(c!.maxTradeUsd).toBeLessThan(b!.maxTradeUsd);
    expect(b!.maxTradeUsd).toBeLessThan(d!.maxTradeUsd);
    expect(c!.maxEquityPct).toBeLessThan(b!.maxEquityPct);
    expect(c!.allowMediumRisk).toBe(false);
    expect(d!.allowMediumRisk).toBe(true);
  });

  it("balanced matches the demo: a $50 cap, so a $150 order is over the limit", () => {
    expect(presetPolicy("balanced", "v").maxTradeUsd).toBe(50);
  });
});
