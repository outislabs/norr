import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Norr's hosted MCP endpoint (TLS terminates inside the attested CVM). */
export const DEFAULT_MCP_URL = "https://mcp.norr.finance/mcp";

/** This package's version (kept equal to package.json; a test checks it). */
export const VERSION = "0.1.1";

export interface BridgeOptions {
  /** The hosted endpoint, e.g. https://mcp.norr.finance/mcp. */
  url: string;
  /** The Norr agent token for one vault. Sent only to `url`, as a bearer header. */
  token: string;
  /** For tests. */
  fetch?: typeof fetch;
}

/**
 * A stdio-facing MCP server that forwards every tool listing and call to Norr's hosted endpoint. It keeps no state
 * and adds no tools of its own: what the agent sees is exactly what the service offers (and enforces).
 */
export function createBridge(o: BridgeOptions): { server: Server; close: () => Promise<void> } {
  if (!o.token) throw new Error("NORR_AGENT_TOKEN is missing. Create one in the Norr dashboard (Connect).");
  const url = new URL(o.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("NORR_MCP_URL must be https (http only for localhost).");

  let remote: Promise<Client> | null = null;
  const connect = (): Promise<Client> =>
    (remote ??= (async () => {
      const client = new Client({ name: "norr-mcp-bridge", version: VERSION });
      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${o.token}` } }, ...(o.fetch ? { fetch: o.fetch } : {}) });
      await client.connect(transport);
      return client;
    })().catch((e) => {
      remote = null; // try again on the next call
      throw e;
    }));

  const server = new Server({ name: "norr", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => (await connect()).listTools());
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    try {
      return (await (await connect()).callTool(req.params)) as CallToolResult;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: `Could not reach Norr at ${url.origin}: ${why}. The hosted service may be offline; nothing was traded.` }] };
    }
  });
  return {
    server,
    close: async () => {
      await server.close();
      if (remote) await (await remote.catch(() => null))?.close();
    },
  };
}
