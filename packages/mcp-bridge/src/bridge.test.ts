import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMockEnclave, listen } from "@norr/enclave";
import { createHttpServer } from "@norr/mcp/src/http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBridge } from "./bridge";

// The whole chain, in process: an MCP client -> this bridge (stdio side, in memory) -> the real hosted endpoint code
// (streamable HTTP) -> the Norr service in mock mode.
let service: Awaited<ReturnType<typeof listen>>;
let mock: ReturnType<typeof createMockEnclave>;
let endpoint: ReturnType<typeof createHttpServer>;
let mcpUrl = "";

beforeAll(async () => {
  mock = createMockEnclave();
  service = await listen(mock.app);
  endpoint = createHttpServer({ apiUrl: service.url });
  await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", () => r()));
  mcpUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => {
  endpoint.close();
  await service.close();
});

async function connect(token: string, url = mcpUrl) {
  const bridge = createBridge({ url, token });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(a);
  const client = new Client({ name: "test-agent", version: "1" });
  await client.connect(b);
  return { client, close: async () => (await client.close(), await bridge.close()) };
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

describe("@norrfi/mcp bridge", () => {
  it("exposes exactly the hosted endpoint's tools and forwards calls with the agent's token", async () => {
    const { client, close } = await connect(mock.agentToken);
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["about_norr", "check_asset", "exit_position", "get_activity", "get_market_data", "get_pnl", "get_policy", "get_portfolio", "get_quote", "list_assets", "trade"]);
      expect(JSON.parse(text(await client.callTool({ name: "get_policy", arguments: {} }))).maxTradeUsd).toBe(50);
      const blocked = JSON.parse(text(await client.callTool({ name: "trade", arguments: { side: "buy", asset: "TSLA", amountUsd: 150 } })));
      expect(blocked).toMatchObject({ status: "blocked", code: "OVER_TRADE_LIMIT" });
    } finally {
      await close();
    }
  });

  it("a wrong token is refused by the service, not by the bridge", async () => {
    const { client, close } = await connect("norr_agent_not_a_real_token");
    try {
      const r = (await client.callTool({ name: "get_policy", arguments: {} })) as { isError?: boolean };
      expect(r.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("says plainly when the hosted service cannot be reached", async () => {
    const { client, close } = await connect(mock.agentToken, "http://127.0.0.1:9/mcp");
    try {
      const r = (await client.callTool({ name: "get_policy", arguments: {} })) as { isError?: boolean };
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("nothing was traded");
    } finally {
      await close();
    }
  });

  it("refuses to start without a token or over plain http to a remote host", () => {
    expect(() => createBridge({ url: mcpUrl, token: "" })).toThrow(/NORR_AGENT_TOKEN/);
    expect(() => createBridge({ url: "http://mcp.example.com/mcp", token: "t" })).toThrow(/https/);
  });
});
