import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EnclaveError, type EnclaveClient } from "./client";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true as const });

/** Run a call and turn service errors into tool errors the agent can read. Decisions (even blocked ones) are normal results. */
async function run(fn: () => Promise<unknown>) {
  try {
    return text(await fn());
  } catch (e) {
    return fail(e instanceof EnclaveError ? e.message : `The Norr service answered something this tool could not read (${e instanceof Error ? e.message : String(e)}).`);
  }
}

const side = z.enum(["buy", "sell"]).describe("buy spends USD cash to get the asset; sell turns the asset back into USD cash.");
const asset = z.string().min(1).describe("A crypto symbol (SOL), a stock/ETF ticker (NVDA), or an exact asset id from list_assets.");
const amountUsd = z.number().positive().describe("The trade size in US dollars.");

/**
 * The nine Norr tools. They are thin wrappers over the agent API: the vault comes from the token,
 * and no tool can move funds out, change rules, or choose a destination.
 */
export function createNorrServer(client: EnclaveClient): McpServer {
  const server = new McpServer({ name: "norr", version: "0.1.0" });
  const read = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    "list_assets",
    {
      title: "List tradable assets",
      description:
        "List what you can trade through Norr. Crypto is listed by symbol and chain. Tokenized stocks and ETFs are listed by ticker (for example NVDA) with every issuer that offers it; ask for the ticker and Norr picks the best price. " +
        "Stock and ETF entries show a minimumUsd: the smallest order that has been quoting for that ticker (about $5.10 for the most liquid names, $26 for the rest; it can be higher outside US market hours). " +
        "Use class to filter. Call this first if you are not sure an asset exists.",
      inputSchema: { class: z.enum(["crypto", "equity"]).optional().describe("Only crypto, or only tokenized stocks and ETFs.") },
      annotations: read,
    },
    ({ class: cls }) => run(() => client.get("/v1/assets", { class: cls })),
  );

  server.registerTool(
    "check_asset",
    {
      title: "Check an asset before trading",
      description:
        "Check one asset before you trade it. For crypto: a risk verdict (low, medium or high, with reasons) from Scam Shield, which scores market data (liquidity, market cap, age) and contract checks from GoPlus Security (honeypot, mint and freeze authority, owner privileges, blacklist, taxes); risk.contract lists the contract findings, or says why the contract could not be checked. For stocks and ETFs: whether this vault may trade them, plus the notice you must respect. " +
        "It also reports any active security incident on the NEAR Intents network that touches the asset. A high risk or an active incident means trade will be blocked, so do not try to work around it.",
      inputSchema: { asset },
      annotations: read,
    },
    ({ asset: a }) => run(() => client.get("/v1/assets/check", { asset: a })),
  );

  server.registerTool(
    "get_quote",
    {
      title: "Get a price without trading",
      description:
        "Dry run: price a trade and see what it would return, with the minimum you would accept. No funds move. For stocks it also shows the observed minimum order size, and warns if a sell would leave a remainder too small to sell later (under $5.10). If your vault's rules or the asset's risk would stop the trade, you get the same blocked answer trade would give, with the reason. Use this to plan before you trade.",
      inputSchema: { side, asset, amountUsd },
      annotations: read,
    },
    ({ side: s, asset: a, amountUsd: usd }) => run(() => client.post("/v1/quote", { side: s, asset: a, amountUsd: usd })),
  );

  server.registerTool(
    "trade",
    {
      title: "Trade",
      description:
        "Request a trade for your vault. The answer is one of: executed (it happened, with the fill); blocked (a rule or safety check stopped it: the message says why, so adjust the request instead of repeating it unchanged); " +
        "pending_approval (the vault owner must approve it first; check get_activity later and do not resend); or failed (nothing was lost, read the message). " +
        "Norr checks your rules, the asset's risk and a daily spending cap first, and verifies the result afterwards. Trades run in the vault's confidential layer whenever it holds the funds there (the answer's 'venue' says which layer was used), so the trade stays off the public chain. You cannot choose where funds go: they always stay in your vault. " +
        "Norr's rules are authoritative: if you are unsure whether a trade is allowed, ask Norr instead of guessing or refusing in advance. Request it (or use get_quote) and read the answer, which names the rule and says what would fit. " +
        "'reason' is your private note to the vault owner explaining why you are making this trade; it is never shown to anyone else.",
      inputSchema: { side, asset, amountUsd, reason: z.string().max(2000).optional().describe("Why you want this trade. Private to the vault owner.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ side: s, asset: a, amountUsd: usd, reason }) => run(() => client.post("/v1/trade", { side: s, asset: a, amountUsd: usd, reason: reason ?? "" })),
  );

  server.registerTool(
    "get_portfolio",
    {
      title: "Vault holdings",
      description: "What your vault holds right now, valued in US dollars and split into crypto and tokenized stocks. Check this before selling, and to see how close you are to the equity limit.",
      annotations: read,
    },
    () => run(() => client.get("/v1/portfolio")),
  );

  server.registerTool(
    "get_policy",
    {
      title: "Your rules",
      description:
        "The rules you must stay within: the largest single trade, the daily spending cap and how much of it is left today, the daily loss cap, the share of the vault allowed in stocks, which assets are allowed, the cooldown between trades, whether stocks are enabled, whether the vault is paused, and whether this deployment checks the NEAR Intents incident feed (incidentFeed; every trade answer carries it too). Read this to plan trades that will not be blocked.",
      annotations: read,
    },
    () => run(() => client.get("/v1/policy")),
  );

  server.registerTool(
    "get_market_data",
    {
      title: "Market data for an asset",
      description:
        "Numbers for one asset: its listed price and, for crypto, the market signals Norr's Scam Shield scores (liquidity in USD, market cap, token age in days), the GoPlus contract findings, and the resulting risk level. For stocks and ETFs: the price per issuer and the smallest order that quotes. " +
        "Read-only facts, not advice. Use it to size and compare trades; check_asset gives the full risk reasons.",
      inputSchema: { asset },
      annotations: read,
    },
    ({ asset: a }) => run(() => client.get("/v1/market", { asset: a })),
  );

  server.registerTool(
    "get_pnl",
    {
      title: "Profit and loss",
      description:
        "Profit and loss since the vault's first trade, per asset and in total: realized (from sells, at average cost) and unrealized (what is still held from your buys, at today's price), with what was bought and sold. " +
        "Only positions bought through Norr are counted; deposits have no known cost. Use it to judge how your trading is going before deciding what to do next.",
      annotations: read,
    },
    () => run(() => client.get("/v1/pnl")),
  );

  server.registerTool(
    "get_activity",
    {
      title: "Recent activity",
      description:
        "The vault's recent trade requests and their outcomes, newest first. Swaps that were waiting for the owner's approval are settled here once the owner has approved them, so use this to follow up on a pending_approval.",
      annotations: read,
    },
    () => run(() => client.get("/v1/activity")),
  );

  return server;
}
