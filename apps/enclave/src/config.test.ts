import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicy, parseOrigins } from "./config";
import { policy } from "./fixtures";

describe("loadPolicy", () => {
  it("reads inline JSON, which wins over a file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "norr-cfg-")), "p.json");
    writeFileSync(file, JSON.stringify(policy({ maxTradeUsd: 1 })));
    expect(loadPolicy({ NORR_POLICY_JSON: JSON.stringify(policy({ maxTradeUsd: 7 })), NORR_POLICY_FILE: file }).maxTradeUsd).toBe(7);
    expect(loadPolicy({ NORR_POLICY_FILE: file }).maxTradeUsd).toBe(1);
  });

  it("refuses a missing or invalid policy rather than guessing one", () => {
    expect(() => loadPolicy({})).toThrow(/NORR_POLICY_FILE or NORR_POLICY_JSON/);
    expect(() => loadPolicy({ NORR_POLICY_JSON: JSON.stringify({ ...policy(), maxTradeUsd: -1 }) })).toThrow();
    expect(() => loadPolicy({ NORR_POLICY_JSON: "{ nope" })).toThrow();
  });
});

describe("parseOrigins", () => {
  it("accepts bare https origins and localhost over http", () => {
    expect(parseOrigins("https://app.norr.finance, http://localhost:5173")).toEqual(["https://app.norr.finance", "http://localhost:5173"]);
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins("  ")).toEqual([]);
  });

  it("refuses anything that could allow more than one site or a downgrade", () => {
    for (const bad of ["*", "app.norr.finance", "http://app.norr.finance", "https://app.norr.finance/", "https://app.norr.finance/path", "https://*.norr.finance"]) {
      expect(() => parseOrigins(bad)).toThrow(/NORR_ALLOWED_ORIGINS/);
    }
  });
});
