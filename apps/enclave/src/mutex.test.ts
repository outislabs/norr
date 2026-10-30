import { describe, expect, it } from "vitest";
import { KeyedMutex } from "./mutex";

const gap = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("KeyedMutex", () => {
  it("runs tasks for the same key strictly one after another, in order", async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    const task = (name: string, ms: number) => m.run("v", async () => { log.push(`${name}:start`); await gap(ms); log.push(`${name}:end`); return name; });
    const results = await Promise.all([task("a", 15), task("b", 1), task("c", 1)]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("does not make different keys wait for each other", async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    const slow = m.run("v1", async () => { await gap(30); log.push("v1"); });
    const fast = m.run("v2", async () => { log.push("v2"); });
    await Promise.all([slow, fast]);
    expect(log).toEqual(["v2", "v1"]);
  });

  it("a failing task does not block the ones behind it, and its error still reaches its caller", async () => {
    const m = new KeyedMutex();
    const bad = m.run("v", async () => { throw new Error("boom"); });
    const good = m.run("v", async () => "ok");
    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe("ok");
  });
});
