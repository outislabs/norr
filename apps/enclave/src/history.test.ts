import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileValueHistory, MAX_POINTS, MIN_GAP_MS, MemoryValueHistory } from "./history";
import { DataCipher } from "./seal";

const pt = (t: number, totalUsd = 100) => ({ t, totalUsd, cryptoUsd: totalUsd, equityUsd: 0 });
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "norr-hist-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("value history", () => {
  it("keeps one reading per gap and drops the rest", () => {
    const h = new MemoryValueHistory();
    expect(h.record("v", pt(0))).toBe(true);
    expect(h.record("v", pt(MIN_GAP_MS - 1))).toBe(false);
    expect(h.record("v", pt(MIN_GAP_MS))).toBe(true);
    expect(h.list("v").map((p) => p.t)).toEqual([0, MIN_GAP_MS]);
    expect(h.list("other")).toEqual([]);
  });

  it("caps the number of readings, dropping the oldest", () => {
    const h = new MemoryValueHistory(0);
    for (let i = 0; i < MAX_POINTS + 5; i++) h.record("v", pt(i));
    const l = h.list("v");
    expect(l).toHaveLength(MAX_POINTS);
    expect(l[0]!.t).toBe(5);
  });

  it("survives a restart, and the file on disk is encrypted", () => {
    const dir = tmp();
    const cipher = DataCipher.random();
    new FileValueHistory(dir, cipher).record("v1", pt(1000, 123456.78));
    const again = new FileValueHistory(dir, cipher);
    expect(again.list("v1")).toEqual([pt(1000, 123456.78)]);
    expect(again.record("v1", pt(1000 + MIN_GAP_MS, 5))).toBe(true);
    const [file] = readdirSync(join(dir, "history"));
    const raw = readFileSync(join(dir, "history", file!), "utf8");
    expect(raw).not.toContain("123456");
    expect(raw).not.toContain("totalUsd");
    expect(new FileValueHistory(dir, cipher).list("v1")).toHaveLength(2);
  });

  it("a different data key cannot read the file", () => {
    const dir = tmp();
    new FileValueHistory(dir, DataCipher.random()).record("v1", pt(1));
    expect(() => new FileValueHistory(dir, DataCipher.random()).list("v1")).toThrow();
  });
});
