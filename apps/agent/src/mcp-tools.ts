import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool } from "./loop";

export interface NorrConnection {
  tools: AgentTool[];
  close(): Promise<void>;
}

/**
 * Connect to Norr's MCP endpoint with the agent's own token and expose its tools to the model. The token is the
 * only credential the agent holds; it cannot move funds out, change rules or choose a destination.
 */
export async function connectNorr(o: { url: string; token: string }): Promise<NorrConnection> {
  const client = new Client({ name: "norr-agent", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(o.url), { requestInit: { headers: { authorization: `Bearer ${o.token}` } } }));
  const listed = await client.listTools();
  const tools: AgentTool[] = listed.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    async call(args) {
      const res = await client.callTool({ name: t.name, arguments: args });
      const text = (Array.isArray(res.content) ? res.content : []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
      return res.isError ? JSON.stringify({ error: text || "The tool reported an error." }) : text;
    },
  }));
  return { tools, close: () => client.close() };
}
