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

/** Where a vault trades: only the public Intents layer, confidential when possible (default), or confidential only. */
export const Privacy = z.enum(["public", "prefer", "require"]);
export type Privacy = z.infer<typeof Privacy>;

export const Venue = z.enum(["public", "confidential"]);
export type Venue = z.infer<typeof Venue>;

export const Policy = z.object({
  vaultId: z.string().min(1),
  maxTradeUsd: z.number().positive(),
  dailySpendCapUsd: z.number().nonnegative(), // total buys per UTC day; stops splitting a big trade into small ones
  dailyLossCapUsd: z.number().nonnegative(),
  maxEquityPct: z.number().min(0).max(100),
  allowedCrypto: z.union([z.array(z.string()), z.literal("any_safe")]),
  allowedEquities: z.array(z.string()),
  cooldownSec: z.number().int().nonnegative(),
  paused: z.boolean(), // kill switch
  nonUsConfirmed: z.boolean(), // owner confirmed non-US status; required for equities
  allowMediumRisk: z.boolean(), // medium Scam Shield verdicts pass only if the owner opts in
  privacy: Privacy.default("prefer"), // prefer = trade confidentially whenever the vault holds the funds there
});
export type Policy = z.infer<typeof Policy>;

export const TradeRequest = z.object({
  vaultId: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  asset: z.string().min(1), // symbol or asset id
  amountUsd: z.number().positive(),
  reason: z.string(), // agent's stated reasoning (kept private)
  /** Sell the vault's whole balance of the asset; amountUsd is then a ceiling (a holding worth more is refused). */
  sellAll: z.boolean().optional(),
});
export type TradeRequest = z.infer<typeof TradeRequest>;

/** What an agent sends over the API. The vault comes from its token, never from the body. */
export const TradeInput = z.object({
  side: z.enum(["buy", "sell"]),
  asset: z.string().min(1).max(200),
  amountUsd: z.number().positive().max(1_000_000),
  reason: z.string().max(2000).default(""),
  /** Sell the whole position (no remainder left behind); amountUsd is then the most it may be worth. */
  sellAll: z.boolean().optional(),
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
  "DAILY_SPEND_CAP",
  "PRIVACY_UNAVAILABLE",
  "PRICING_UNAVAILABLE",
  "VAULT_CAP",
  "AMBIGUOUS_ASSET",
  "BELOW_MIN_SELL",
]);
export type BlockCode = z.infer<typeof BlockCode>;

/**
 * A way out offered with BELOW_MIN_SELL: sell the whole position, top it up and then sell all of it, or (owner only)
 * withdraw the tokens to the owner's own wallet.
 */
export const ExitOption = z.object({
  kind: z.enum(["sell_all", "top_up_and_sell_all", "withdraw"]),
  /** sell_all: what the position is worth; top_up_and_sell_all: the buy needed first. */
  usd: z.number().optional(),
  /** Only the vault's owner can do it (the agent has no withdraw tool). */
  ownerOnly: z.boolean().optional(),
  how: z.string(),
});
export type ExitOption = z.infer<typeof ExitOption>;

export const Decision = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("executed"),
    txRef: z.string(),
    filled: z.object({ asset: z.string(), amount: z.string(), priceUsd: z.number() }),
    /** Which layer the trade ran in. */
    venue: Venue.optional(),
    /** "independent" = checked against a source the custody provider does not control; "custody-reported" = checked against the provider's own balances and reports. */
    verification: z.enum(["independent", "custody-reported"]).optional(),
    /** Things the agent should know, for example that a sell leaves a remainder too small to sell later. */
    warnings: z.array(z.string()).optional(),
  }),
  z.object({
    status: z.literal("blocked"),
    code: BlockCode,
    message: z.string(),
    /** For NO_LIQUIDITY on a stock: the smallest USD size that quotes right now, if one was found. */
    suggestedUsd: z.number().optional(),
    /** For BELOW_MIN_SELL: the ways out of (or around) a position too small to sell. */
    exits: z.array(ExitOption).optional(),
  }),
  z.object({
    status: z.literal("pending_approval"),
    requestId: z.string(),
    message: z.string(),
    /** Where and until when the owner can approve it. */
    approval: z.object({ where: z.string(), url: z.string().nullable(), expiresAt: z.string() }).optional(),
  }),
  z.object({ status: z.enum(["failed", "refunded"]), message: z.string() }),
]);
export type Decision = z.infer<typeof Decision>;
export * from "./attestation";
