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
const asset = z.string().min(1).optional().describe("A crypto symbol (SOL), a stock/ETF ticker (NVDA), an exact asset id from list_assets, or chain:contract (base:0x833589…). Or use chain and contract instead.");
const chain = z.string().min(2).max(20).optional().describe("With contract: the chain the token lives on, as NEAR Intents names it (eth, base, arb, sol, near, bsc, …).");
const contract = z.string().min(2).max(128).optional().describe("With chain: the token's contract address (mint address on Solana, account id on NEAR). Use it when a symbol is ambiguous.");
/** The asset string the service understands: the symbol or id, or chain:contract. */
const target = (p: { asset?: string; chain?: string; contract?: string }): string | null => (p.chain && p.contract ? `${p.chain.trim().toLowerCase()}:${p.contract.trim()}` : p.asset?.trim() || null);
const NEED_ASSET = "Name the asset: a symbol or ticker (asset), or chain and contract.";
const amountUsd = z.number().positive().describe("The trade size in US dollars.");

/**
 * Sent to the agent on initialize. Factual and short; about_norr gives the live details for the agent's vault.
 * Nothing here may claim more than docs/PRIVACY.md does.
 */
export const NORR_INSTRUCTIONS = [
  "Norr lets you trade crypto and tokenized stocks for one vault through NEAR Intents, inside rules the vault's owner sets. Your token is for that one vault.",
  "Custody: the vault is an OutLayer custody wallet whose keys live in OutLayer's TEE. For self-serve vaults, the owner's NEAR account stored the custody policy on chain and is its controller; Norr cannot change it. You cannot withdraw, change rules, or choose where funds go: trades settle back into the vault, withdrawals go only to the owner.",
  "Approvals: by default every swap waits for the owner's approval in the Norr dashboard (the vault's Approvals tab); approvals expire after 24 hours. A pending_approval answer carries the link. Tell the owner, follow up with get_activity, and do not resend. Autonomous mode is optional and off by default: the owner turns it on or off in Rules. When it is on, swaps run without the owner's signature but only within the largest trade, the daily cap and the operations-per-hour limit (a trade over a limit is refused), and money can only reach the owner's whitelisted address. about_norr says which mode this vault is in.",
  "Privacy: trades run in NEAR Intents' confidential layer when the vault's funds are there (see 'venue'), so amounts and pairs are not on the public chain. Not private from OutLayer, the NEAR Intents operator and solvers, or the Norr service. Funding and withdrawals are public.",
  "What Norr stores: each request and its outcome in a ledger encrypted at rest inside the service (it enforces the caps with it; get_activity shows it); your 'reason' sealed to the owner's key, readable only by the owner. Request bodies, balances, positions and rules are not logged. Do not say Norr logs every request in the clear: it does not.",
  "Integrity: the hosted service runs in an attested Intel TDX VM that anyone can verify (about_norr gives the status and a verify link).",
  "Norr's rules are authoritative. When unsure if a trade is allowed, use get_quote or trade and read the answer instead of refusing in advance. For questions about how Norr works, call about_norr rather than guessing.",
].join("\n");

/**
 * The Norr tools. They are thin wrappers over the agent API: the vault comes from the token,
 * and no tool can move funds out, change rules, or choose a destination.
 */
export function createNorrServer(client: EnclaveClient): McpServer {
  const server = new McpServer({ name: "norr", version: "0.1.0" }, { instructions: NORR_INSTRUCTIONS });
  const read = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    "about_norr",
    {
      title: "How Norr works",
      description:
        "Facts about Norr for your vault, from the running service: who holds the keys and who controls the custody policy, what you can and cannot do, whether swaps wait for the owner's approval (and where, and how long an approval lasts), who can see what, what Norr stores, whether the service runs in an attested enclave (with a verify link), and whether the NEAR Intents incident feed is checked. Call it before answering questions about Norr's custody, privacy or safety.",
      annotations: read,
    },
    () => run(() => client.get("/v1/about")),
  );

  server.registerTool(
    "list_assets",
    {
      title: "List tradable assets",
      description:
        "List what you can trade through Norr. Crypto is listed by symbol and chain. Tokenized stocks and ETFs are listed by ticker (for example NVDA) with every issuer that offers it; ask for the ticker and Norr picks the best price. " +
        "Stock and ETF entries show a minimumUsd: the smallest order that has been quoting for that ticker (about $5.10 for the most liquid names, $26 for the rest; minimums vary with available liquidity). " +
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
        "Name a token by chain and contract to check that exact contract; one NEAR Intents does not route gets a safety report and the answer that it cannot be traded privately. If several tokens share a symbol, the answer says so (ambiguous) and lists each one's chain and contract. " +
        "It also reports any active security incident on the NEAR Intents network that touches the asset. A high risk or an active incident means trade will be blocked, so do not try to work around it.",
      inputSchema: { asset, chain, contract },
      annotations: read,
    },
    (p) => (target(p) ? run(() => client.get("/v1/assets/check", { asset: target(p)! })) : Promise.resolve(fail(NEED_ASSET))),
  );

  server.registerTool(
    "get_quote",
    {
      title: "Get a price without trading",
      description:
        "Dry run: price a trade and see what it would return, with the minimum you would accept. No funds move. For stocks it also shows the observed minimum order size, and warns if a sell would leave a remainder too small to sell later (under $5.10). If your vault's rules or the asset's risk would stop the trade, you get the same blocked answer trade would give, with the reason. Use this to plan before you trade.",
      inputSchema: { side, asset, chain, contract, amountUsd },
      annotations: read,
    },
    (p) => (target(p) ? run(() => client.post("/v1/quote", { side: p.side, asset: target(p), amountUsd: p.amountUsd })) : Promise.resolve(fail(NEED_ASSET))),
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
      inputSchema: { side, asset, chain, contract, amountUsd, reason: z.string().max(2000).optional().describe("Why you want this trade. Private to the vault owner.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (p) => (target(p) ? run(() => client.post("/v1/trade", { side: p.side, asset: target(p), amountUsd: p.amountUsd, reason: p.reason ?? "" })) : Promise.resolve(fail(NEED_ASSET))),
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
      inputSchema: { asset, chain, contract },
      annotations: read,
    },
    (p) => (target(p) ? run(() => client.get("/v1/market", { asset: target(p)! })) : Promise.resolve(fail(NEED_ASSET))),
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
