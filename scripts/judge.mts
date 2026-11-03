/**
 * pnpm judge: one command that checks this repository's claims with no funds, no keys and no network.
 *
 *   1. Typecheck (both TypeScript projects).
 *   2. The whole test suite.
 *   3. The demo, as an agent sees it: a real MCP client spawns the MCP server over stdio (as Claude Desktop does)
 *      and trades against the Norr service in mock mode.
 *   4. The owner side over HTTP: NEP-413 sign-in, funding from another chain, the kill switch.
 *   5. A production build of the dashboard, including its generated Content-Security-Policy.
 *
 * Installs nothing. Prints PASS/FAIL per check with the file that proves it, and exits non-zero on any failure.
 * Flags: --no-tests (skip step 2, about 90 s), --no-build (skip step 5).
 */
// The MCP SDK is a dependency of apps/mcp (workspace packages are not hoisted to the root), so it is imported from there.
import { Client } from "../apps/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../apps/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { createMockEnclave, MOCK_OWNER } from "../apps/enclave/src/mock-enclave";
import { listen } from "../apps/enclave/src/serve";
import { nep413Hash } from "../apps/enclave/src/owner/nep413";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name: string) => join(root, "node_modules/.bin", name);
const args = new Set(process.argv.slice(2));

interface Result { step: string; check: string; ok: boolean; detail: string; proof: string }
const results: Result[] = [];
const record = (step: string, check: string, ok: boolean, detail: string, proof: string) => {
  results.push({ step, check, ok, detail, proof });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${check}${detail ? `  (${detail})` : ""}`);
};
const run = (cmd: string, argv: string[], cwd = root) => spawnSync(cmd, argv, { cwd, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });

// ---------- 1. Typecheck ----------
console.log("\n1. Typecheck");
for (const p of ["tsconfig.json", "apps/web/tsconfig.json"]) {
  const r = run(bin("tsc"), ["-p", p, "--noEmit"]);
  record("typecheck", `tsc -p ${p}`, r.status === 0, r.status === 0 ? "" : (r.stdout + r.stderr).trim().split("\n").slice(0, 3).join(" | "), p);
}

// ---------- 2. Tests ----------
if (!args.has("--no-tests")) {
  console.log("\n2. Test suite (vitest, about 90 s)");
  const dir = mkdtempSync(join(tmpdir(), "norr-judge-"));
  const out = join(dir, "vitest.json");
  run(bin("vitest"), ["run", "--reporter=json", `--outputFile=${out}`]);
  try {
    const j = JSON.parse(readFileSync(out, "utf8")) as { numTotalTests: number; numPassedTests: number; numFailedTests: number; testResults: { name: string; status: string }[] };
    const failedFiles = j.testResults.filter((t) => t.status !== "passed").map((t) => t.name.replace(root + "/", ""));
    record("tests", `${j.numPassedTests}/${j.numTotalTests} tests pass in ${j.testResults.length} files`, j.numFailedTests === 0 && j.numPassedTests > 0, failedFiles.join(", "), "**/*.test.ts(x)");
  } catch {
    record("tests", "vitest produced a report", false, "no JSON report", "vitest.config.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else console.log("\n2. Test suite: skipped (--no-tests)");

// ---------- 3 + 4. The demo against the mock service ----------
console.log("\n3. Demo as an agent sees it (a real MCP stdio process, the mock service, no funds)");
let skewMs = 0; // the mock's clock: advanced past a cooldown instead of sleeping through it
const mock = createMockEnclave({ now: () => Date.now() + skewMs });
const server = await listen(mock.app);
const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>;
const transport = new StdioClientTransport({ command: bin("tsx"), args: [join(root, "apps/mcp/src/stdio.ts")], env: { PATH: process.env.PATH ?? "", NORR_API_URL: server.url, NORR_AGENT_TOKEN: mock.agentToken }, stderr: "pipe" });
const agent = new Client({ name: "norr-judge", version: "1" });
try {
  await agent.connect(transport);
  const tool = async (name: string, a: Record<string, unknown> = {}) => parse(await agent.callTool({ name, arguments: a }));
  const tools = (await agent.listTools()).tools.map((t) => t.name).sort();
  const expected = ["check_asset", "get_activity", "get_market_data", "get_pnl", "get_policy", "get_portfolio", "get_quote", "list_assets", "trade"];
  record("demo", "the MCP server exposes 9 tools; none can withdraw, change rules or set a destination", JSON.stringify(tools) === JSON.stringify(expected), tools.join(", "), "apps/mcp/src/tools.ts");

  const policy = await tool("get_policy");
  record("demo", "get_policy returns the vault's rules", policy.maxTradeUsd === 50, `max trade $${policy.maxTradeUsd}, cooldown ${policy.cooldownSec}s`, "apps/mcp/src/tools.ts, packages/core/src/presets.ts");

  const nvda = await tool("trade", { side: "buy", asset: "NVDA", amountUsd: 40, reason: "judge: tokenized stock" });
  record("demo", "buy $40 of NVDA (a tokenized stock) executes", nvda.status === "executed", `${nvda.status}${nvda.venue ? `, ${nvda.venue}` : ""}`, "apps/enclave/src/trade.ts, packages/core/src/registry.ts");

  const tsla = await tool("trade", { side: "buy", asset: "TSLA", amountUsd: 150, reason: "judge: over the limit" });
  record("demo", "buy $150 of TSLA is blocked by the per-trade limit", tsla.code === "OVER_TRADE_LIMIT", String(tsla.code), "packages/core/src/policy.ts");

  const rug = await tool("trade", { side: "buy", asset: "RUGPULL", amountUsd: 5, reason: "judge: scam token" });
  record("demo", "buy $5 of a rug token is blocked by Scam Shield", rug.code === "SCAM_RISK", String(rug.code), "packages/core/src/risk.ts");

  const tooSoon = await tool("trade", { side: "buy", asset: "SOL", amountUsd: 5, reason: "judge: cooldown" });
  record("demo", "a trade inside the cooldown is blocked", tooSoon.code === "COOLDOWN", String(tooSoon.code), "packages/core/src/policy.ts");
  skewMs += (Number(policy.cooldownSec) + 1) * 1000;
  const sol = await tool("trade", { side: "buy", asset: "SOL", amountUsd: 5, reason: "judge: cross-chain" });
  record("demo", "after the cooldown, buy $5 of SOL (cross-chain) executes", sol.status === "executed", String(sol.status), "apps/enclave/src/trade.ts");

  const pnl = await tool("get_pnl");
  const pnlAssets = ((pnl.assets ?? []) as { asset: string }[]).map((a) => a.asset).sort();
  record("demo", "get_pnl reports P&L per asset since the first trade (realized and unrealized)", JSON.stringify(pnlAssets) === JSON.stringify(["NVDAon", "SOL"]) && typeof (pnl.totals as { totalUsd?: unknown })?.totalUsd === "number", `${pnlAssets.join(", ")}; total ${(pnl.totals as { totalUsd: number }).totalUsd}`, "packages/core/src/pnl-report.ts, apps/enclave/src/vault-pnl.ts");
  const market = await tool("get_market_data", { asset: "RUGPULL" });
  const v0 = (market.versions as { liquidityUsd: number; risk: { level: string } }[])[0];
  record("demo", "get_market_data shows the numbers Scam Shield scored (liquidity, risk level)", v0?.liquidityUsd === 3200 && v0?.risk?.level === "high", `liquidity $${v0?.liquidityUsd}, risk ${v0?.risk?.level}`, "apps/enclave/src/app.ts (/v1/market)");

  const activity = await tool("get_activity");
  const items = (Array.isArray(activity) ? activity : (activity.activity ?? activity.items ?? [])) as unknown[];
  record("demo", "get_activity lists the agent's decisions", items.length >= 5, `${items.length} entries`, "apps/enclave/src/app.ts");

  // ---------- 4. Owner side ----------
  console.log("\n4. Owner side over HTTP (NEP-413 sign-in, funding from another chain, kill switch)");
  const req = async (path: string, init: { token?: string; body?: unknown } = {}) =>
    fetch(server.url + path, { method: init.body !== undefined ? "POST" : "GET", headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) }, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = `ed25519:${base58(publicKey.export({ format: "der", type: "spki" }).subarray(-32))}`;
  const c = (await (await req("/owner/v1/challenge")).json()) as { message: string; nonce: string; recipient: string };
  const signature = sign(null, nep413Hash({ message: c.message, nonce: Buffer.from(c.nonce, "base64"), recipient: c.recipient }), privateKey).toString("base64");
  const login = await req("/owner/v1/login", { body: { accountId: MOCK_OWNER, publicKey: pub, signature, nonce: c.nonce } });
  const token = login.status === 200 ? ((await login.json()) as { token: string }).token : "";
  record("owner", "the owner signs in with a NEP-413 signed message", !!token, `HTTP ${login.status}`, "apps/enclave/src/owner/auth.ts, apps/enclave/src/owner/nep413.ts");
  const agentAsOwner = await req("/owner/v1/vaults/demo", { token: mock.agentToken });
  record("owner", "the agent's token is refused on owner routes", agentAsOwner.status === 401, `HTTP ${agentAsOwner.status}`, "apps/enclave/src/owner/routes.ts");

  // Watch what the service asks 1Click for: the recipient must be the vault's own account, whatever the page sends.
  const quoted: { recipient: string; originAsset?: string }[] = [];
  const realQuote = mock.deps.funder!.requestDeposit.bind(mock.deps.funder);
  mock.deps.funder!.requestDeposit = async (p) => (quoted.push(p), realQuote(p));
  const { sources } = (await (await req("/owner/v1/funding/sources", { token })).json()) as { sources: { assetId: string; chain: string }[] };
  const base = sources.find((s) => s.chain === "base");
  const offer = (await (await req("/owner/v1/vaults/demo/funding", { token, body: { amountUsd: 2, source: base?.assetId, refundTo: "0x8ba1f109551bD432803012645Ac136ddd64DBA72", recipient: "attacker.near" } })).json()) as { address?: string; send?: { chainName: string } };
  const vaultAccount = mock.deps.vaults.get("demo")!.walletAccount;
  record("owner", "funding from another chain (USDC on Base) gets a one-time address, and the recipient is the vault even if the request names another", !!offer.address && offer.send?.chainName === "Base" && quoted[0]?.recipient === vaultAccount && quoted[0]?.originAsset === base?.assetId, `recipient ${quoted[0]?.recipient}, ${sources.length} sources offered`, "apps/enclave/src/owner/routes.ts, packages/core/src/funding-sources.ts");
  const wrongRefund = await req("/owner/v1/vaults/demo/funding", { token, body: { amountUsd: 2, source: base?.assetId, refundTo: "alice.near" } });
  record("owner", "a refund address on the wrong chain is refused before any quote", wrongRefund.status === 400, `HTTP ${wrongRefund.status}`, "packages/core/src/funding-sources.ts");

  const paused = await req("/owner/v1/pause-all", { token, body: {} });
  const afterPause = await tool("trade", { side: "buy", asset: "SOL", amountUsd: 5, reason: "judge: after the kill switch" });
  record("owner", "kill switch: after Pause everything, the agent's next trade returns PAUSED", paused.ok && afterPause.code === "PAUSED", String(afterPause.code), "apps/enclave/src/owner/routes.ts, packages/core/src/policy.ts");

  const att = await req("/attestation?nonce=" + "00".repeat(32));
  record("owner", "mock mode says honestly there is no enclave to attest (503)", att.status === 503, `HTTP ${att.status}`, "apps/enclave/src/attestation.ts");
} catch (e) {
  record("demo", "the demo ran to completion", false, e instanceof Error ? e.message : String(e), "scripts/judge.mts");
} finally {
  await agent.close().catch(() => undefined);
  await server.close();
}

// ---------- 5. Dashboard build ----------
if (!args.has("--no-build")) {
  console.log("\n5. Dashboard production build");
  const out = mkdtempSync(join(tmpdir(), "norr-judge-web-"));
  const r = run(bin("vite"), ["build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], join(root, "apps/web"));
  record("build", "the dashboard builds", r.status === 0, r.status === 0 ? "" : (r.stdout + r.stderr).trim().split("\n").slice(0, 2).join(" | "), "apps/web");
  try {
    const csp = readFileSync(join(out, "_headers"), "utf8").match(/Content-Security-Policy: (.*)/)?.[1] ?? "";
    const strict = /script-src 'self' 'wasm-unsafe-eval'(;|$)/.test(csp) && !/unsafe-inline|[^-]'unsafe-eval'/.test(csp) && csp.includes("frame-ancestors 'none'");
    record("build", "the build ships a strict CSP (no inline code, no JS eval, no framing)", strict, csp.split("; ").slice(0, 3).join("; "), "apps/web/src/lib/csp.ts");
  } catch {
    record("build", "the build ships a strict CSP", false, "no _headers file", "apps/web/vite.config.ts");
  }
  rmSync(out, { recursive: true, force: true });
} else console.log("\n5. Dashboard build: skipped (--no-build)");

// ---------- Summary ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(72)}\n${failed.length === 0 ? "PASS" : "FAIL"}: ${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL  [${f.step}] ${f.check}: ${f.detail}  -> ${f.proof}`);
console.log("Where each claim is proven: AGENTS.md. Live (not mock) evidence: README 'What is live today' and docs/FINDINGS.md.");
process.exit(failed.length ? 1 : 0);

function base58(buf: Buffer): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = A[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}
