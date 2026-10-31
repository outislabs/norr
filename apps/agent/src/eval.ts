// Which model should drive the demo agent? Runs each candidate through the demo scenarios against a fresh mock
// Norr service (no funds, no network except the model API) and scores what happened in the vault.
//   pnpm --filter @norr/agent exec tsx src/eval.ts [--models a,b] [--reps 2] [--scenarios buy-nvda,rug] [--out results.json]
import { createHttpServer } from "@norr/mcp";
import { createMockEnclave, listen } from "@norr/enclave";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { ChatClient, costUsd, listModels, type ModelInfo, type Usage } from "./llm";
import { runAgent, type RunResult } from "./loop";
import { connectNorr } from "./mcp-tools";
import { SYSTEM_PROMPT } from "./prompts";
import { judge, SCENARIOS, type Outcome } from "./scenarios";

// The repo's .env, whether run from the root or from apps/agent. Missing is fine: the real environment is used.
for (const file of [".env", "../../.env"]) {
  try {
    process.loadEnvFile(file);
    break;
  } catch {
    /* not here */
  }
}

const { values } = parseArgs({ options: { models: { type: "string" }, reps: { type: "string", default: "2" }, scenarios: { type: "string" }, out: { type: "string" } } });
const apiKey = process.env.NEAR_AI_API_KEY ?? "";
if (!apiKey) {
  console.error("Set NEAR_AI_API_KEY in .env.");
  process.exit(1);
}
const BUDGET = Number(process.env.NEAR_AI_EVAL_BUDGET_USD ?? 1);
const baseUrl = process.env.NEAR_AI_BASE_URL;

const all = await listModels({ apiKey, baseUrl });
const byId = new Map(all.map((m) => [m.id, m]));
// Default: NEAR's own attested-TEE models that support tools, plus one third-party-TEE model as a quality reference.
const defaults = all.filter((m) => m.owner === "nearai" && m.tools && !/abliterated/i.test(m.id)).map((m) => m.id).concat(byId.has("moonshotai/kimi-k2.6") ? ["moonshotai/kimi-k2.6"] : []);
const models: ModelInfo[] = (values.models ? values.models.split(",") : defaults).map((id) => {
  const m = byId.get(id.trim());
  if (!m) throw new Error(`Unknown model: ${id}`);
  return m;
});
const scenarios = values.scenarios ? SCENARIOS.filter((s) => values.scenarios!.split(",").includes(s.id)) : SCENARIOS;
const reps = Math.max(1, Number(values.reps));
const llm = new ChatClient({ apiKey, baseUrl });

interface Row {
  model: string;
  scenario: string;
  rep: number;
  pass: boolean;
  problems: string[];
  turns: number;
  usage: Usage;
  cost: number;
  invalidArgs: number;
  unknownTools: number;
  toolCalls: string[];
  finalText: string;
}
const rows: Row[] = [];
let spent = 0;

async function once(model: ModelInfo, scenarioIndex: number, rep: number): Promise<Row> {
  const s = scenarios[scenarioIndex]!;
  const m = createMockEnclave(); // fresh vault every run: runs cannot affect each other
  const enclave = await listen(m.app);
  const http = createHttpServer({ apiUrl: enclave.url });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const conn = await connectNorr({ url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, token: m.agentToken });
  try {
    const run: RunResult = await runAgent({ llm, model: model.id, system: SYSTEM_PROMPT, task: s.task, tools: conn.tools });
    const outcomes: Outcome[] = m.deps.ledger.list(m.vaultId).map((e) => ({
      side: e.request.side,
      asset: e.request.asset,
      amountUsd: e.request.amountUsd,
      status: e.decision.status,
      ...(e.decision.status === "blocked" ? { code: e.decision.code } : {}),
    }));
    const v = judge(s, run, outcomes);
    const cost = costUsd(run.usage, model.price);
    return { model: model.id, scenario: s.id, rep, pass: v.pass, problems: v.problems, turns: run.turns, usage: run.usage, cost, invalidArgs: run.invalidArgs, unknownTools: run.unknownTools, toolCalls: run.toolCalls.map((c) => c.name), finalText: run.finalText.slice(0, 400) };
  } finally {
    await conn.close().catch(() => undefined);
    await new Promise<void>((r) => http.close(() => r()));
    await enclave.close();
  }
}

outer: for (const model of models) {
  for (let i = 0; i < scenarios.length; i++) {
    for (let rep = 1; rep <= reps; rep++) {
      if (spent > BUDGET) {
        console.error(`Stopping: spent $${spent.toFixed(3)}, over the $${BUDGET} budget (NEAR_AI_EVAL_BUDGET_USD).`);
        break outer;
      }
      const row = await once(model, i, rep);
      spent += row.cost;
      rows.push(row);
      console.log(`${row.pass ? "PASS" : "FAIL"}  ${model.id.padEnd(42)} ${row.scenario.padEnd(11)} #${rep}  ${row.turns} turns  ${row.usage.promptTokens}+${row.usage.completionTokens} tok  $${row.cost.toFixed(4)}${row.pass ? "" : `  - ${row.problems.join("; ")}`}`);
    }
  }
}

console.log("\nSummary");
for (const model of models) {
  const mine = rows.filter((r) => r.model === model.id);
  if (mine.length === 0) continue;
  const pass = mine.filter((r) => r.pass).length;
  const cost = mine.reduce((n, r) => n + r.cost, 0);
  const perRun = cost / mine.length;
  console.log(
    `${model.id.padEnd(42)} ${String(pass).padStart(2)}/${mine.length} passed  invalid-args ${mine.reduce((n, r) => n + r.invalidArgs, 0)}  unknown-tools ${mine.reduce((n, r) => n + r.unknownTools, 0)}  avg turns ${(mine.reduce((n, r) => n + r.turns, 0) / mine.length).toFixed(1)}  $${perRun.toFixed(4)}/run  $${cost.toFixed(3)} total`,
  );
}
console.log(`\nTotal spent (upper bound, cache discounts not applied): $${spent.toFixed(3)}`);
if (values.out) writeFileSync(values.out, JSON.stringify({ at: new Date().toISOString(), reps, rows }, null, 2));
