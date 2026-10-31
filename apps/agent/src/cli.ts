// Run the demo agent against a Norr MCP endpoint with a task, and print what it did.
//   pnpm --filter @norr/agent exec tsx src/cli.ts --mcp http://127.0.0.1:8788/mcp --model <id> "Buy $40 of NVDA"
// The agent token comes from NORR_AGENT_TOKEN, never from the command line.
import { parseArgs } from "node:util";
import { ChatClient, costUsd, listModels } from "./llm";
import { runAgent } from "./loop";
import { connectNorr } from "./mcp-tools";
import { SYSTEM_PROMPT } from "./prompts";

// The repo's .env, whether run from the root or from apps/agent. Missing is fine: the real environment is used.
for (const file of [".env", "../../.env"]) {
  try {
    process.loadEnvFile(file);
    break;
  } catch {
    /* not here */
  }
}
const { values, positionals } = parseArgs({ allowPositionals: true, options: { mcp: { type: "string" }, model: { type: "string" } } });
const apiKey = process.env.NEAR_AI_API_KEY ?? "";
const token = process.env.NORR_AGENT_TOKEN ?? "";
const task = positionals.join(" ").trim();
if (!apiKey || !token || !values.mcp || !values.model || !task) {
  console.error('usage: NORR_AGENT_TOKEN=... run --mcp <url>/mcp --model <id> "<task>"   (needs NEAR_AI_API_KEY in .env)');
  process.exit(1);
}
const model = (await listModels({ apiKey })).find((m) => m.id === values.model);
if (!model) {
  console.error(`Unknown model: ${values.model}`);
  process.exit(1);
}
const conn = await connectNorr({ url: values.mcp, token });
try {
  const run = await runAgent({ llm: new ChatClient({ apiKey }), model: model.id, system: SYSTEM_PROMPT, task, tools: conn.tools });
  for (const c of run.toolCalls) console.log(`tool  ${c.name}(${JSON.stringify(c.args)})\n      -> ${c.result.slice(0, 300)}`);
  console.log(`\n${run.stopped === "answer" ? run.finalText : `[${run.stopped}] ${run.error ?? ""}`}`);
  console.log(`\n${run.turns} turns, ${run.usage.promptTokens}+${run.usage.completionTokens} tokens, about $${costUsd(run.usage, model.price).toFixed(4)}`);
} finally {
  await conn.close();
}
