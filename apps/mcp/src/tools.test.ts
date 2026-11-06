import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMockEnclave } from "@norr/enclave";
import { describe, expect, it } from "vitest";
import { EnclaveClient } from "./client";
import { createNorrServer } from "./tools";

const T0 = Date.UTC(2026, 10, 3, 12);

async function connect(opts: { token?: string; fetch?: (u: string, i?: RequestInit) => Promise<Response> } = {}) {
  const clock = { t: T0 };
  const m = createMockEnclave({ now: () => clock.t });
  m.deps.sleep = async (ms) => { clock.t += ms; };
  m.deps.settle = { waitMs: 0, intervalMs: 1 };
  const via = async (url: string, init?: RequestInit) => m.app.request(url.replace("http://enclave.test", ""), init);
  const client = new EnclaveClient({ baseUrl: "http://enclave.test", token: opts.token ?? m.agentToken, fetch: opts.fetch ?? via });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createNorrServer(client).connect(a);
  const mcp = new Client({ name: "test-agent", version: "1" });
  await mcp.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    return { isError: Boolean(r.isError), text, json: () => JSON.parse(text) };
  };
  return { m, mcp, call, clock };
}

describe("tool surface", () => {
  it("exposes exactly the ten Norr tools, each with a description", async () => {
    const { mcp } = await connect();
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["about_norr", "check_asset", "get_activity", "get_market_data", "get_pnl", "get_policy", "get_portfolio", "get_quote", "list_assets", "trade"]);
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(40);
  });

  it("no tool takes a destination, address, recipient, vault or token argument", async () => {
    const { mcp } = await connect();
    for (const t of (await mcp.listTools()).tools) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      for (const p of props) expect(p).not.toMatch(/recipient|destination|address|vault|token|account|withdraw/i);
    }
  });

  it("marks reads as read-only and trade as not", async () => {
    const { mcp } = await connect();
    const byName = Object.fromEntries((await mcp.listTools()).tools.map((t) => [t.name, t]));
    for (const n of ["list_assets", "check_asset", "get_quote", "get_portfolio", "get_policy", "get_activity"]) expect(byName[n]!.annotations?.readOnlyHint).toBe(true);
    expect(byName.trade!.annotations?.readOnlyHint).toBe(false);
  });

  it("trade requires side and amountUsd, and an asset either as asset or as chain + contract; reason is optional", async () => {
    const { mcp, call } = await connect();
    const trade = (await mcp.listTools()).tools.find((t) => t.name === "trade")!;
    expect((trade.inputSchema as { required: string[] }).required.sort()).toEqual(["amountUsd", "side"]);
    expect(Object.keys((trade.inputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(["asset", "chain", "contract", "reason"]));
    const none = await call("trade", { side: "buy", amountUsd: 5 });
    expect(none).toMatchObject({ isError: true, text: "Name the asset: a symbol or ticker (asset), or chain and contract." });
  });
});

describe("tools against the mock Norr service", () => {
  it("runs the demo: buy NVDA, blocked TSLA, blocked rug, buy SOL", async () => {
    const { call, clock } = await connect();
    expect((await call("list_assets", { class: "equity" })).json().equities.map((e: { ticker: string }) => e.ticker)).toContain("NVDA");
    expect((await call("check_asset", { asset: "RUGPULL" })).json().versions[0].risk.level).toBe("high");
    expect((await call("get_policy")).json().maxTradeUsd).toBe(50);

    const q = (await call("get_quote", { side: "buy", asset: "NVDA", amountUsd: 40 })).json();
    expect(q.status).toBe("quote");

    const nvda = await call("trade", { side: "buy", asset: "NVDA", amountUsd: 40, reason: "momentum" });
    expect(nvda.isError).toBe(false);
    expect(nvda.json().status).toBe("executed");
    expect(nvda.json()).toMatchObject({ venue: "confidential", verification: "custody-reported" }); // the mock vault holds its cash confidentially

    const tsla = await call("trade", { side: "buy", asset: "TSLA", amountUsd: 150, reason: "big bet" });
    expect(tsla.isError).toBe(false); // a block is an answer, not a tool failure
    expect(tsla.json()).toMatchObject({ status: "blocked", code: "OVER_TRADE_LIMIT" });

    expect((await call("trade", { side: "buy", asset: "RUGPULL", amountUsd: 5 })).json()).toMatchObject({ status: "blocked", code: "SCAM_RISK" });

    clock.t += 60_000;
    expect((await call("trade", { side: "buy", asset: "SOL", amountUsd: 5 })).json().status).toBe("executed");

    const pf = (await call("get_portfolio")).json();
    expect(pf.holdings.map((h: { symbol: string }) => h.symbol)).toEqual(expect.arrayContaining(["USDC", "NVDAon", "SOL"]));
  });

  it("get_activity shows outcomes but never the private reason", async () => {
    const { call } = await connect();
    await call("trade", { side: "buy", asset: "SOL", amountUsd: 5, reason: "TOP-SECRET-THESIS" });
    const a = await call("get_activity");
    expect(a.text).toContain("SOL");
    expect(a.text).not.toContain("TOP-SECRET-THESIS");
  });

  it("surfaces pause as a normal blocked answer", async () => {
    const { m, call } = await connect();
    m.vaults.pause("demo", "owner");
    expect((await call("trade", { side: "buy", asset: "SOL", amountUsd: 5 })).json()).toMatchObject({ status: "blocked", code: "PAUSED" });
  });

  it("pending approvals come back as pending_approval", async () => {
    const { m, call } = await connect();
    // Use the approval-required rails by swapping in a custody that always waits.
    const vault = m.vaults.get("demo")!;
    vault.custody = { ...vault.custody, swap: async () => ({ state: "pending_approval", requestId: "r-1" }), status: async () => ({ state: "pending_approval", requestId: "r-1" }) };
    expect((await call("trade", { side: "buy", asset: "SOL", amountUsd: 5 })).json()).toMatchObject({ status: "pending_approval", requestId: "r-1" });
  });

  it("rejects malformed arguments before they reach the service", async () => {
    const { mcp } = await connect();
    const r = await mcp.callTool({ name: "trade", arguments: { side: "hold", asset: "SOL", amountUsd: -1 } }).catch((e: unknown) => e);
    const failed = r instanceof Error || (r as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
  });
});

describe("errors the agent can act on", () => {
  it("a wrong or revoked token is a clear tool error that never echoes the token", async () => {
    const { call } = await connect({ token: "norr_agent_wrong_token_value" });
    const r = await call("get_policy");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("token was rejected");
    expect(r.text).not.toContain("norr_agent_wrong_token_value");
  });

  it("an unreachable service is a clear tool error", async () => {
    const { call } = await connect({ fetch: async () => { throw new Error("ECONNREFUSED"); } });
    const r = await call("list_assets");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Could not reach the Norr service");
    expect(r.text).not.toContain("ECONNREFUSED");
  });

  it("a 500 from the service is reported without internals", async () => {
    const { call } = await connect({ fetch: async () => new Response(JSON.stringify({ error: "internal error" }), { status: 500 }) });
    const r = await call("get_policy");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("internal error");
  });
});

describe("trade is authoritative, even when the agent skips every pre-check", () => {
  it("a cold trade call gets Norr's own reason for each kind of block", async () => {
    const { call } = await connect();
    // No list_assets, check_asset or get_quote first.
    const tsla = (await call("trade", { side: "buy", asset: "TSLA", amountUsd: 150, reason: "x" })).json();
    expect(tsla).toMatchObject({ status: "blocked", code: "OVER_TRADE_LIMIT" });
    expect(tsla.message).toMatch(/\$150.*\$50/);

    const rug = (await call("trade", { side: "buy", asset: "RUGPULL", amountUsd: 5, reason: "ape" })).json();
    expect(rug).toMatchObject({ status: "blocked", code: "SCAM_RISK" });
    expect(rug.message).toMatch(/liquidity/i);
  });

  it("the daily spending cap stops a split trade through MCP, with what is left", async () => {
    const { call, clock } = await connect();
    for (let i = 0; i < 3; i++) {
      expect((await call("trade", { side: "buy", asset: "SOL", amountUsd: 50 })).json().status).toBe("executed");
      clock.t += 11_000;
    }
    expect((await call("get_policy")).json()).toMatchObject({ dailySpendCapUsd: 150, spendRemainingTodayUsd: 0 });
    const d = (await call("trade", { side: "buy", asset: "SOL", amountUsd: 10 })).json();
    expect(d).toMatchObject({ status: "blocked", code: "DAILY_SPEND_CAP" });
    expect(d.message).toContain("daily spending cap");
  });

  it("the tool guidance tells agents to ask Norr rather than pre-judge", async () => {
    const { mcp } = await connect();
    const trade = (await mcp.listTools()).tools.find((t) => t.name === "trade")!;
    expect(trade.description).toContain("ask Norr instead of guessing");
  });
});

describe("what agents are told about Norr (from a new user's test on the Claude app, 2026-11-05)", () => {
  it("instructions arrive on initialize: custody, approvals, privacy and what is stored, without claiming plaintext logging", async () => {
    const { mcp } = await connect();
    const ins = mcp.getInstructions() ?? "";
    expect(ins).toMatch(/OutLayer custody wallet whose keys live in OutLayer's TEE/);
    expect(ins).toMatch(/controller; Norr cannot change it/);
    expect(ins).toMatch(/Approvals tab\); approvals expire after 24 hours/);
    expect(ins).toMatch(/Autonomous mode is optional and off by default: the owner turns it on or off in Rules/);
    expect(ins).toMatch(/only within the largest trade, the daily cap and the operations-per-hour limit \(a trade over a limit is refused\)/);
    expect(ins).toMatch(/money can only reach the owner's whitelisted address/);
    expect(ins).toMatch(/ledger encrypted at rest/);
    expect(ins).toMatch(/sealed to the owner's key/);
    expect(ins).toMatch(/Request bodies, balances, positions and rules are not logged/);
    expect(ins).not.toMatch(/logs every request(?! in the clear: it does not)/);
    expect(ins.length).toBeLessThan(2500); // short
  });

  it("about_norr answers from the running service", async () => {
    const { call } = await connect();
    const a = (await call("about_norr")).json();
    expect(a.custody.provider).toMatch(/OutLayer/);
    expect(a.custody.you).toMatch(/cannot withdraw, change rules, or choose where funds go/);
    expect(a.custody.trust).toMatch(/not trustless/);
    expect(a.approvals).toMatchObject({ mode: "none", required: false }); // the mock demo vault has no approval step
    expect(a.autonomousMode.what).toMatch(/Optional and off by default.*owner turns it on or off in Rules/);
    expect(a.autonomousMode.whenOn).toMatch(/only within the vault's largest trade, daily spending cap.*operations-per-hour limit.*refused/);
    expect(a.autonomousMode.money).toMatch(/only reach the owner's whitelisted address/);
    expect(a.storage.reasoning).toMatch(/only the owner can read it/);
    expect(a.operator.operatorCannot).toMatch(/cannot read the sealed reasoning.*cannot send money anywhere but the owner's whitelisted address/);
    expect(a.operator.today).toMatch(/operator holds the key that encrypts Norr's stored data.*could decrypt a copy of the data, or deploy changed code.*proposed, not built/);
    expect(a.operator.others).toMatch(/OutLayer sees every custody operation.*solvers see confidential intents in plaintext/);
    expect(a.attestation.status).toMatch(/not running in a TEE/);
    expect(a.attestation.verifyUrl).toBe("http://localhost:5173/#/verify");
    expect(a.incidentFeed).toBeTruthy();
  });

  it("quotes say whether the swap would wait for approval; a pending trade says where, with the link and the expiry", async () => {
    const m = createMockEnclave({ requireApproval: true, now: () => T0 });
    m.deps.settle = { waitMs: 0, intervalMs: 1 };
    const via = async (url: string, init?: RequestInit) => m.app.request(url.replace("http://enclave.test", ""), init);
    const client = new EnclaveClient({ baseUrl: "http://enclave.test", token: m.agentToken, fetch: via });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createNorrServer(client).connect(a);
    const mcp = new Client({ name: "t", version: "1" });
    await mcp.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await mcp.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text);
    const q = await call("get_quote", { side: "buy", asset: "SOL", amountUsd: 5 });
    expect(q.approval).toMatchObject({ required: true, mode: "owner", url: "http://localhost:5173/#/vault/demo/approvals", expiresHours: 24 });
    expect(q.approval.note).toMatch(/Every swap in this vault waits for the owner's approval/);
    const t = await call("trade", { side: "buy", asset: "SOL", amountUsd: 5 });
    expect(t.status).toBe("pending_approval");
    expect(t.approval).toEqual({ where: "Norr dashboard, the vault's Approvals tab", url: "http://localhost:5173/#/vault/demo/approvals", expiresAt: new Date(T0 + 24 * 3600_000).toISOString() });
    expect(t.message).toMatch(/waiting for the vault owner's approval in the Norr dashboard.*expires at .*24 hours/);
  });
});
