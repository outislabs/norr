import { addUsage, type Chat, type ChatMessage, type ToolDef, type Usage } from "./llm";

/** A tool the agent may call. `call` returns the text the model sees. */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<string>;
}

export interface ToolRecord {
  name: string;
  args: Record<string, unknown> | null;
  result: string;
}

export interface RunResult {
  finalText: string;
  turns: number;
  toolCalls: ToolRecord[];
  usage: Usage;
  /** Tool calls whose arguments were not valid JSON. */
  invalidArgs: number;
  /** Tool calls naming a tool that does not exist. */
  unknownTools: number;
  stopped: "answer" | "max_turns" | "error";
  error?: string;
  /** Completion ids, for fetching each response's signature. */
  chatIds: string[];
  /** The hashes each response signature covers, one per completion that carried them. */
  exchanges: { id: string; model: string; requestHash: string; responseHash: string }[];
}

export const toToolDefs = (tools: AgentTool[]): ToolDef[] => tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** What the model sees of a tool result is capped, so one large response cannot swamp the context. */
const MAX_RESULT_CHARS = 6000;

/**
 * Let the model act through its tools until it answers in plain text. Every failure mode a weaker model has
 * (broken JSON arguments, a tool that does not exist) is fed back to it once as an error and counted, rather than
 * crashing the run, so an evaluation measures the model and not the harness.
 */
export async function runAgent(o: { llm: Chat; model: string; system: string; task: string; tools: AgentTool[]; maxTurns?: number }): Promise<RunResult> {
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const defs = toToolDefs(o.tools);
  const messages: ChatMessage[] = [
    { role: "system", content: o.system },
    { role: "user", content: o.task },
  ];
  const out: RunResult = { finalText: "", turns: 0, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, invalidArgs: 0, unknownTools: 0, stopped: "max_turns", chatIds: [], exchanges: [] };
  const maxTurns = o.maxTurns ?? 10;

  for (let turn = 0; turn < maxTurns; turn++) {
    out.turns = turn + 1;
    let reply;
    try {
      reply = await o.llm.chat({ model: o.model, messages, tools: defs });
    } catch (e) {
      out.stopped = "error";
      out.error = e instanceof Error ? e.message : String(e);
      return out;
    }
    out.usage = addUsage(out.usage, reply.usage);
    out.chatIds.push(reply.id);
    if (reply.exchange) out.exchanges.push({ id: reply.id, ...reply.exchange });
    messages.push(reply.message);

    const calls = reply.message.tool_calls ?? [];
    if (calls.length === 0) {
      out.finalText = reply.message.content ?? "";
      out.stopped = "answer";
      return out;
    }

    for (const c of calls) {
      const tool = byName.get(c.function.name);
      let args: Record<string, unknown> | null = null;
      let result: string;
      try {
        const parsed: unknown = c.function.arguments.trim() === "" ? {} : JSON.parse(c.function.arguments);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        args = parsed as Record<string, unknown>;
      } catch {
        out.invalidArgs++;
      }
      if (!tool) {
        out.unknownTools++;
        result = JSON.stringify({ error: `There is no tool named "${c.function.name}". Available tools: ${[...byName.keys()].join(", ")}.` });
      } else if (!args) {
        result = JSON.stringify({ error: "The arguments were not a valid JSON object. Send them again as one JSON object." });
      } else {
        try {
          result = await tool.call(args);
        } catch (e) {
          result = JSON.stringify({ error: e instanceof Error ? e.message : "The tool failed." });
        }
      }
      out.toolCalls.push({ name: c.function.name, args, result });
      messages.push({ role: "tool", tool_call_id: c.id, content: result.slice(0, MAX_RESULT_CHARS) });
    }
  }
  return out;
}
