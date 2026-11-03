/**
 * End-to-end check of a hosted Norr MCP endpoint with Claude Code itself, in print mode. Nothing is added to your
 * Claude configuration: the server is passed with --mcp-config and --strict-mcp-config for this run only.
 *
 *   pnpm exec tsx scripts/claude-code-mcp.mts <MCP URL> [token file]
 *
 * The agent token is read from a file (default config/agent-token.local.txt, gitignored), never from the command line.
 * The prompts only read, except one trade request above the vault's per-trade limit, which Norr must refuse.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, tokenFile = "config/agent-token.local.txt"] = process.argv.slice(2);
if (!url) throw new Error("usage: tsx scripts/claude-code-mcp.mts <MCP URL> [token file]");
const token = readFileSync(tokenFile, "utf8").trim();
const dir = mkdtempSync(join(tmpdir(), "norr-cc-"));
const config = join(dir, "mcp.json");
writeFileSync(config, JSON.stringify({ mcpServers: { norr: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });

const READS = ["list_assets", "check_asset", "get_market_data", "get_quote", "get_portfolio", "get_pnl", "get_policy", "get_activity"].map((t) => `mcp__norr__${t}`);
const prompts: { name: string; prompt: string; allow: string[]; expect: RegExp }[] = [
  { name: "tools are listed and the rules are read", prompt: "Using only the norr MCP tools: call get_policy and tell me the vault's largest single trade in USD. Answer with the number and the name of the tool you called.", allow: READS, expect: /get_policy/i },
  { name: "portfolio and P&L are read", prompt: "Using only the norr MCP tools: call get_portfolio and get_pnl, then summarise the vault's total value and total P&L in two sentences.", allow: READS, expect: /\$|USD|value/i },
  { name: "an over-limit trade is refused by Norr", prompt: "Use the norr trade tool to buy $5000 of SOL. Submit it even if you expect it to be refused, then report Norr's exact answer (status and code).", allow: [...READS, "mcp__norr__trade"], expect: /OVER_TRADE_LIMIT|DAILY_SPEND_CAP|PAUSED|SHIELD_INCIDENT|blocked/i },
];
let failed = 0;
try {
  for (const p of prompts) {
    const r = spawnSync("claude", ["-p", p.prompt, "--mcp-config", config, "--strict-mcp-config", "--allowedTools", ...p.allow, "--output-format", "text"], { encoding: "utf8", timeout: 240_000 });
    const out = (r.stdout + r.stderr).trim();
    const ok = r.status === 0 && p.expect.test(out);
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${p.name}\n      ${out.replace(/\s+/g, " ").slice(0, 400)}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
