import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "./bridge";
import { CONNECTOR_HELP, WAITING_LINE, startup } from "./startup";

const here = dirname(fileURLToPath(import.meta.url));

describe("what someone sees when they run npx @norrfi/mcp", () => {
  it("by hand, with no token: what this is and how to use it, then it stops", () => {
    const s = startup({ token: undefined, interactive: true });
    expect(s).toEqual({ start: false, exitCode: 1, stderr: [CONNECTOR_HELP] });
    expect(CONNECTOR_HELP).toContain("Norr MCP connector. This isn't run on its own");
    expect(CONNECTOR_HELP).toContain("Connect tab at app.norr.finance");
    expect(CONNECTOR_HELP).toContain("Add https://mcp.norr.finance/mcp as a connector instead — no token needed.");
  });

  it("started by an app whose config lacks the token: says that first, with the same explanation", () => {
    for (const token of [undefined, "", "   "]) {
      const s = startup({ token, interactive: false });
      expect(s.start).toBe(false);
      expect(s.stderr[0]).toMatch(/^norr-mcp: NORR_AGENT_TOKEN is missing from this app's MCP config\. Norr MCP connector\./);
    }
  });

  it("by hand, with a token: one line saying it waits for an MCP client", () => {
    expect(startup({ token: "t", interactive: true })).toEqual({ start: true, stderr: [WAITING_LINE] });
    expect(WAITING_LINE).toContain("waiting for an MCP client");
  });

  it("started by an MCP client with a token: starts quietly (stdout is the protocol, nothing extra on stderr)", () => {
    expect(startup({ token: "t", interactive: false })).toEqual({ start: true, stderr: [] });
  });

  it("the version the bridge reports matches package.json", () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(join(here, "../package.json"), "utf8")).version);
  });
});

describe("the real CLI process", () => {
  const tsx = join(here, "../../../node_modules/.bin/tsx");
  const run = (env: Record<string, string>) =>
    spawnSync(tsx, [join(here, "cli.ts")], { env: { PATH: process.env.PATH ?? "", ...env }, input: "", encoding: "utf8", timeout: 30_000 });

  it("with no token (stdin not a terminal, as when an app starts it): exits 1, explains on stderr, writes nothing to stdout", () => {
    const r = run({});
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("NORR_AGENT_TOKEN is missing from this app's MCP config");
    expect(r.stderr).toContain("Norr MCP connector. This isn't run on its own");
  }, 40_000);
});
