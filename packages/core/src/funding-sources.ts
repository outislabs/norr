import type { RegistryEntry } from "./registry";

/**
 * Funding a vault from any chain. The owner holds USDC (or ETH, SOL) on some chain; Norr asks 1Click for a one-time
 * deposit address on that chain whose route ends as USDC in the vault's confidential balance. The destination is
 * fixed by the service; the owner only chooses where the money comes from and where a refund would go.
 *
 * Every route listed here was quoted live (dry) on 2026-11-03: USDC from each chain arrives at about 0.01% cost.
 */

export type ChainFamily = "near" | "evm" | "solana";

export interface ChainInfo {
  name: string;
  family: ChainFamily;
  /** EVM chain id, for asking a browser wallet to switch network. */
  evmChainId?: number;
}

/** 1Click blockchain codes Norr offers for funding, in display order. */
export const FUNDING_CHAINS: Record<string, ChainInfo> = {
  near: { name: "NEAR", family: "near" },
  eth: { name: "Ethereum", family: "evm", evmChainId: 1 },
  base: { name: "Base", family: "evm", evmChainId: 8453 },
  arb: { name: "Arbitrum", family: "evm", evmChainId: 42161 },
  op: { name: "Optimism", family: "evm", evmChainId: 10 },
  pol: { name: "Polygon", family: "evm", evmChainId: 137 },
  bsc: { name: "BNB Chain", family: "evm", evmChainId: 56 },
  sol: { name: "Solana", family: "solana" },
};

/** Which tokens may fund a vault on each chain. Stablecoins everywhere; the main native coins where they are common. */
const FUNDING_TOKENS: { symbol: string; chains: string[] }[] = [
  { symbol: "USDC", chains: Object.keys(FUNDING_CHAINS) },
  { symbol: "ETH", chains: ["eth", "base", "arb"] },
  { symbol: "SOL", chains: ["sol"] },
];

export interface FundingSource {
  assetId: string;
  symbol: string;
  chain: string;
  chainName: string;
  family: ChainFamily;
  evmChainId?: number;
  decimals: number;
  /** The token's contract on its own chain; null for a native coin (ETH, SOL) or for NEAR's own entry. */
  contract: string | null;
  priceUsd: number;
}

/** The sources to offer, from the live token list. A token without a price is left out (the amount is set in USD). */
export function fundingSources(entries: RegistryEntry[]): FundingSource[] {
  const out: FundingSource[] = [];
  for (const [chain, info] of Object.entries(FUNDING_CHAINS)) {
    for (const t of FUNDING_TOKENS) {
      if (!t.chains.includes(chain)) continue;
      const e = entries.find((x) => x.class === "crypto" && x.chain === chain && x.symbol === t.symbol && x.priceUsd !== null && x.priceUsd > 0);
      if (!e) continue;
      out.push({ assetId: e.id, symbol: e.symbol, chain, chainName: info.name, family: info.family, ...(info.evmChainId ? { evmChainId: info.evmChainId } : {}), decimals: e.decimals, contract: info.family === "near" ? null : e.contractAddress, priceUsd: e.priceUsd! });
    }
  }
  return out;
}

const NEAR_ACCOUNT = /^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Is this a plausible refund address on the source's chain? 1Click checks it again when quoting. */
export function validRefundAddress(family: ChainFamily, address: string): boolean {
  const a = address.trim();
  if (family === "evm") return EVM_ADDRESS.test(a);
  if (family === "solana") return SOLANA_ADDRESS.test(a);
  return NEAR_ACCOUNT.test(a) || /^[0-9a-f]{64}$/.test(a);
}

/** Smallest units of the source token worth `usd` at its listed price, rounded down. */
export function unitsForUsd(usd: number, priceUsd: number, decimals: number): string {
  if (!(usd > 0) || !(priceUsd > 0)) throw new Error("amount and price must be positive");
  // Work in micro-dollars to stay in integers for any decimals.
  const micro = BigInt(Math.round(usd * 1e6));
  const priceMicro = BigInt(Math.round(priceUsd * 1e6));
  return ((micro * 10n ** BigInt(decimals)) / priceMicro).toString();
}
