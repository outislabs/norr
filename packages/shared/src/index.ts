import { z } from "zod";

export const AssetClass = z.enum(["crypto", "equity"]);
export type AssetClass = z.infer<typeof AssetClass>;

export const Asset = z.object({
  id: z.string().min(1), // 1Click asset id, e.g. "nep141:..."
  symbol: z.string().min(1),
  name: z.string(),
  class: AssetClass,
  chain: z.string().min(1),
  decimals: z.number().int().nonnegative(),
});
export type Asset = z.infer<typeof Asset>;

export const Policy = z.object({
  vaultId: z.string().min(1),
  maxTradeUsd: z.number().positive(),
  dailyLossCapUsd: z.number().nonnegative(),
  maxEquityPct: z.number().min(0).max(100),
  allowedCrypto: z.union([z.array(z.string()), z.literal("any_safe")]),
  allowedEquities: z.array(z.string()),
  cooldownSec: z.number().int().nonnegative(),
  paused: z.boolean(), // kill switch
  nonUsConfirmed: z.boolean(), // owner confirmed non-US status; required for equities
  allowMediumRisk: z.boolean(), // medium Scam Shield verdicts pass only if the owner opts in
});
export type Policy = z.infer<typeof Policy>;

export const TradeRequest = z.object({
  vaultId: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  asset: z.string().min(1), // symbol or asset id
  amountUsd: z.number().positive(),
  reason: z.string(), // agent's stated reasoning (kept private)
});
export type TradeRequest = z.infer<typeof TradeRequest>;

/** What an agent sends over the API. The vault comes from its token, never from the body. */
export const TradeInput = z.object({
  side: z.enum(["buy", "sell"]),
  asset: z.string().min(1).max(200),
  amountUsd: z.number().positive().max(1_000_000),
  reason: z.string().max(2000).default(""),
});
export type TradeInput = z.infer<typeof TradeInput>;

export const BlockCode = z.enum([
  "PAUSED",
  "OVER_TRADE_LIMIT",
  "DAILY_LOSS_CAP",
  "COOLDOWN",
  "ASSET_NOT_ALLOWED",
  "EQUITY_LIMIT",
  "SCAM_RISK",
  "INELIGIBLE",
  "PRICE_SANITY",
  "UNKNOWN_ASSET",
  "NO_LIQUIDITY",
  "SHIELD_INCIDENT",
]);
export type BlockCode = z.infer<typeof BlockCode>;

export const Decision = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("executed"),
    txRef: z.string(),
    filled: z.object({ asset: z.string(), amount: z.string(), priceUsd: z.number() }),
  }),
  z.object({ status: z.literal("blocked"), code: BlockCode, message: z.string() }),
  z.object({ status: z.literal("pending_approval"), requestId: z.string(), message: z.string() }),
  z.object({ status: z.enum(["failed", "refunded"]), message: z.string() }),
]);
export type Decision = z.infer<typeof Decision>;
