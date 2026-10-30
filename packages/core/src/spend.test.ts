import { describe, expect, it } from "vitest";
import { addToDay, emptyDay, releaseFromDay, sumToday } from "./spend";

const t0 = Date.UTC(2026, 10, 3, 12);
const day = 24 * 3_600_000;

describe("daily spend total", () => {
  it("accumulates within a UTC day and resets on the next", () => {
    let d = emptyDay(t0);
    d = addToDay(d, t0, 40);
    d = addToDay(d, t0 + 1000, 25);
    expect(sumToday(d, t0 + 2000)).toBe(65);
    expect(sumToday(d, t0 + day)).toBe(0);
    expect(addToDay(d, t0 + day, 10)).toEqual({ day: "2026-11-04", usd: 10 });
  });

  it("releases a reservation made today, never below zero, and ignores one from a past day", () => {
    const d = addToDay(emptyDay(t0), t0, 40);
    expect(releaseFromDay(d, "2026-11-03", 40).usd).toBe(0);
    expect(releaseFromDay(d, "2026-11-03", 90).usd).toBe(0);
    expect(releaseFromDay(d, "2026-11-02", 40)).toEqual(d);
  });
});
