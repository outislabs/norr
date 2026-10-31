import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EnclaveClient, type FetchLike } from "./client";
import { createNorrServer } from "./tools";

export interface HttpOptions {
  apiUrl: string;
  fetch?: FetchLike;
  /**
   * Extra Host header values to accept, besides localhost. Guards a localhost-bound server against DNS rebinding.
   * "*" accepts any host, for a public deployment behind a gateway, where every request needs the agent's bearer token anyway.
   */
  allowedHosts?: string[];
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
const bearer = (req: IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];

function reject(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
}

/**
 * Streamable HTTP MCP endpoint at /mcp, stateless. The caller's own bearer token is forwarded to the
 * Norr service for that request only; this process stores no tokens.
 */
export function createHttpServer(o: HttpOptions) {
  const allowed = new Set([...LOCAL, ...(o.allowedHosts ?? [])]);
  const anyHost = allowed.has("*");
  return createServer(async (req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!anyHost && !allowed.has(host)) return reject(res, 403, "host not allowed");
    if (req.url === "/health") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    if (req.url !== "/mcp") return reject(res, 404, "not found");

    const token = bearer(req);
    if (!token) return reject(res, 401, "send your Norr agent token as 'Authorization: Bearer <token>'");

    const server = createNorrServer(new EnclaveClient({ baseUrl: o.apiUrl, token, fetch: o.fetch }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) reject(res, 500, "internal error");
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MCP_PORT ?? 8788);
  const host = process.env.MCP_HOST ?? "127.0.0.1";
  const extra = (process.env.MCP_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  createHttpServer({ apiUrl: process.env.NORR_API_URL ?? "http://localhost:8787", allowedHosts: extra }).listen(port, host, () =>
    console.error(`norr-mcp: streamable HTTP on http://${host}:${port}/mcp`),
  );
}
