import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMockEnclave, listen } from "@norr/enclave";
import { request as httpRequest } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "./http";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");

let enclave: Awaited<ReturnType<typeof listen>>;
let mock: ReturnType<typeof createMockEnclave>;

beforeAll(async () => {
  mock = createMockEnclave();
  enclave = await listen(mock.app);
});
afterAll(async () => {
  await enclave.close();
});

const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

describe("real stdio process", () => {
  it("a client spawns apps/mcp/src/stdio.ts and trades through the running mock service", async () => {
    const transport = new StdioClientTransport({
      command: tsx,
      args: [resolve(here, "stdio.ts")],
      env: { PATH: process.env.PATH ?? "", NORR_API_URL: enclave.url, NORR_AGENT_TOKEN: mock.agentToken },
      stderr: "pipe",
    });
    const client = new Client({ name: "claude-desktop-sim", version: "1" });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools).toHaveLength(11);
      expect(parse(await client.callTool({ name: "get_policy", arguments: {} })).maxTradeUsd).toBe(50);
      const t = parse(await client.callTool({ name: "trade", arguments: { side: "buy", asset: "NVDA", amountUsd: 40, reason: "e2e" } }));
      expect(t.status).toBe("executed");
      expect(parse(await client.callTool({ name: "trade", arguments: { side: "buy", asset: "TSLA", amountUsd: 150 } }))).toMatchObject({ code: "OVER_TRADE_LIMIT" });
    } finally {
      await client.close();
    }
  }, 60_000);

  it("exits with a clear message and no protocol output when the token is missing", async () => {
    const transport = new StdioClientTransport({ command: tsx, args: [resolve(here, "stdio.ts")], env: { PATH: process.env.PATH ?? "" }, stderr: "pipe" });
    const client = new Client({ name: "x", version: "1" });
    await expect(client.connect(transport)).rejects.toBeDefined();
  }, 30_000);
});

describe("real streamable HTTP endpoint", () => {
  let http: ReturnType<typeof createHttpServer>;
  let url: string;
  beforeAll(async () => {
    http = createHttpServer({ apiUrl: enclave.url });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
  });
  afterAll(() => new Promise<void>((r) => http.close(() => r())));

  it("refuses requests without a bearer token and bad Host headers", async () => {
    const noAuth = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(noAuth.status).toBe(401);
    // fetch() ignores a custom Host header, so use raw http to send a rebinding-style request.
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(url);
      const r = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { host: "evil.example", authorization: "Bearer x", "content-type": "application/json" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on("error", reject);
      r.end("{}");
    });
    expect(status).toBe(403);
    expect((await fetch(url.replace("/mcp", "/health"))).status).toBe(200);
    expect((await fetch(url.replace("/mcp", "/other"))).status).toBe(404);
  });

  it("a remote agent connects with its token and uses the tools", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${mock.agentToken}` } } });
    const client = new Client({ name: "remote-agent", version: "1" });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("trade");
      expect(parse(await client.callTool({ name: "list_assets", arguments: { class: "crypto" } })).crypto.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("a wrong token yields tool errors, not data", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: "Bearer not_a_real_token" } } });
    const client = new Client({ name: "attacker", version: "1" });
    await client.connect(transport);
    try {
      const r = await client.callTool({ name: "get_portfolio", arguments: {} });
      expect(r.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("public deployments", () => {
  const request = (port: number, host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = httpRequest({ port, host: "127.0.0.1", path: "/health", headers: { host } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      req.on("error", reject).end();
    });

  it('accepts any Host only when told to with "*", and still rejects an unlisted host otherwise', async () => {
    for (const [allowedHosts, host, want] of [[undefined, "norr.example.com", 403], [["norr.example.com"], "norr.example.com", 200], [["norr.example.com"], "other.example.com", 403], [["*"], "anything.example.org", 200]] as const) {
      const s = createHttpServer({ apiUrl: "http://127.0.0.1:1", allowedHosts: allowedHosts as string[] | undefined });
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      try {
        expect(await request((s.address() as import("node:net").AddressInfo).port, host)).toBe(want);
      } finally {
        await new Promise<void>((r) => s.close(() => r()));
      }
    }
  });
});

describe("OAuth resource server (MCP authorization)", () => {
  let http: ReturnType<typeof createHttpServer>;
  let base: string;
  beforeAll(async () => {
    http = createHttpServer({ apiUrl: enclave.url, publicUrl: "https://mcp.norr.test", authServer: enclave.url });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => http.close(() => r())));

  it("serves its protected-resource metadata, pointing at the Norr service", async () => {
    const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(meta).toMatchObject({ resource: "https://mcp.norr.test/mcp", authorization_servers: [enclave.url], bearer_methods_supported: ["header"] });
    expect((await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()).resource).toBe("https://mcp.norr.test/mcp");
    // Clients on the earlier spec look for the authorization server here: passed through.
    expect((await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()).token_endpoint).toMatch(/\/oauth\/token$/);
  });

  it("answers 401 with the sign-in pointer without a token or with an invalid one, and serves a valid one", async () => {
    const init = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) };
    const none = await fetch(`${base}/mcp`, init);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://mcp.norr.test/.well-known/oauth-protected-resource"');
    const bad = await fetch(`${base}/mcp`, { ...init, headers: { ...init.headers, authorization: "Bearer norr_agent_notarealtoken12345" } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
    const ok = await fetch(`${base}/mcp`, { ...init, headers: { ...init.headers, authorization: `Bearer ${mock.agentToken}` } });
    expect(ok.status).toBe(200);
  });
});
