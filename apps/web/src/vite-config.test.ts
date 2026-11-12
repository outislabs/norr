import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../vite.config";

/** Every .js file under a directory. */
function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? jsFiles(p) : p.endsWith(".js") ? [p] : [];
  });
}

describe("vite config", () => {
  // Safari has no Node-style `global`: "Can't find variable: global" broke wallet sign-in before the picker opened, back
  // when the dashboard used wallet-selector, whose wallet SDKs expect it. NEAR Connect does not, so the shim is gone;
  // this keeps it that way, and fails if a future NEAR Connect version starts reading Node globals again.
  it("needs no `global` or `Buffer` shim: the config has none, and NEAR Connect's code reads neither", () => {
    expect(config.define ?? {}).not.toHaveProperty("global");
    expect(config.optimizeDeps?.rolldownOptions?.transform?.define ?? {}).not.toHaveProperty("global");
    const root = dirname(createRequire(import.meta.url).resolve("@hot-labs/near-connect"));
    for (const f of jsFiles(root)) {
      const code = readFileSync(f, "utf8");
      expect(/(?<![\w$.'"`-])global(?![\w$'"`-])/.test(code), `${f} reads a bare \`global\``).toBe(false);
      expect(/(?<![\w$.'"`-])Buffer(?![\w$'"`-])/.test(code.replace(/\/\/.*$/gm, "")), `${f} reads Buffer`).toBe(false);
    }
  });
});
