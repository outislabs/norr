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
  /**
   * OAuth (MCP authorization): this endpoint's public URL (e.g. https://mcp.norr.finance) and its authorization server
   * (the Norr service, e.g. https://api.norr.finance). With both set, a request without a valid token gets a 401 that
   * points the client to the sign-in, and the protected-resource metadata is served. Pasted tokens keep working.
   */
  publicUrl?: string;
  authServer?: string;
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
const bearer = (req: IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];

function reject(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify({ error: message }));
}

const json = (res: ServerResponse, body: unknown) => res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=300" }).end(JSON.stringify(body));

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
    const oauth = o.publicUrl && o.authServer ? { resource: `${o.publicUrl.replace(/\/+$/, "")}/mcp`, as: o.authServer.replace(/\/+$/, ""), meta: `${o.publicUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource` } : null;
    // RFC 9728: where clients learn which authorization server issues tokens for this endpoint.
    if (oauth && (req.url === "/.well-known/oauth-protected-resource" || req.url === "/.well-known/oauth-protected-resource/mcp")) {
      return json(res, { resource: oauth.resource, authorization_servers: [oauth.as], bearer_methods_supported: ["header"], scopes_supported: ["vault"], resource_documentation: "https://norr.finance/docs/connect-agent/" });
    }
    // Clients that follow the earlier MCP spec look for the authorization server's metadata on this host: pass it through.
    if (oauth && req.url === "/.well-known/oauth-authorization-server") {
      try {
        const r = await (o.fetch ?? fetch)(`${oauth.as}/.well-known/oauth-authorization-server`);
        return json(res, await r.json());
      } catch {
        return reject(res, 502, "authorization server unreachable");
      }
    }
    if (req.url !== "/mcp") return reject(res, 404, "not found");

    const challenge = oauth ? { "www-authenticate": `Bearer resource_metadata="${oauth.meta}"` } : undefined;
    const token = bearer(req);
    if (!token) return reject(res, 401, "send your Norr agent token as 'Authorization: Bearer <token>', or connect with OAuth", challenge);
    // With OAuth, check the token first: an expired one must get a 401 here so the client refreshes it.
    if (oauth) {
      const ok = await (o.fetch ?? fetch)(`${o.apiUrl.replace(/\/+$/, "")}/v1/token`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status).catch(() => 0);
      if (ok === 401) return reject(res, 401, "this token is not valid (expired or revoked)", { "www-authenticate": `Bearer error="invalid_token", resource_metadata="${oauth.meta}"` });
      if (ok === 429) return reject(res, 429, "too many requests; wait a minute");
    }

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
  createHttpServer({ apiUrl: process.env.NORR_API_URL ?? "http://localhost:8787", allowedHosts: extra, publicUrl: process.env.MCP_PUBLIC_URL || undefined, authServer: process.env.MCP_AUTH_SERVER || undefined }).listen(port, host, () =>
    console.error(`norr-mcp: streamable HTTP on http://${host}:${port}/mcp`),
  );
}
