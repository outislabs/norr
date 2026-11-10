import { describe, expect, it } from "vitest";
import { unitsToNumber, usdToUnits } from "./units";

describe("units", () => {
  it("converts USD to USDC units (6 decimals, $1)", () => {
    expect(usdToUnits(1.5, 1, 6)).toBe("1500000");
  });

  it("converts USD to an 18-decimal equity token", () => {
    const u = usdToUnits(30, 208, 18);
    expect(u.length).toBe(18); // 0.1442... tokens
    expect(unitsToNumber(u, 18)).toBeCloseTo(30 / 208, 8);
  });

  it("rounds down and never yields more than requested", () => {
    expect(BigInt(usdToUnits(1, 3, 6))).toBe(333333n);
  });

  it("handles a tiny-price token and 9-decimal SOL", () => {
    expect(usdToUnits(5, 0.0001, 6)).toBe("50000000000");
    expect(usdToUnits(1.5, 97.38, 9)).toBe("15403573"); // floor(1.5 / 97.38 * 1e9)
  });

  it("rejects non-positive inputs", () => {
    expect(() => usdToUnits(0, 1, 6)).toThrow();
    expect(() => usdToUnits(1, 0, 6)).toThrow();
    expect(() => usdToUnits(-1, 1, 6)).toThrow();
  });

  it("unitsToNumber round-trips display values", () => {
    expect(unitsToNumber("1497728", 6)).toBeCloseTo(1.497728, 9);
    expect(unitsToNumber("0", 18)).toBe(0);
  });
});

describe("parseUnits and formatUnits", () => {
  it("parses exact decimals and refuses everything else", async () => {
    const { parseUnits, formatUnits } = await import("./units");
    expect(parseUnits("1", 6)).toBe("1000000");
    expect(parseUnits("1.25", 6)).toBe("1250000");
    expect(parseUnits(" 0.000001 ", 6)).toBe("1");
    expect(parseUnits("0.0000001", 6)).toBeNull(); // more places than the token has
    for (const bad of ["0", "0.0", "-1", "1e3", "", "abc", "1,5", "1.", ".5"]) expect(parseUnits(bad, 6)).toBeNull();
    expect(formatUnits("1250000", 6)).toBe("1.25");
    expect(formatUnits("1", 6)).toBe("0.000001");
    expect(formatUnits("5000000", 6)).toBe("5");
    expect(formatUnits(parseUnits("123456.789012", 6)!, 6)).toBe("123456.789012");
  });
});
