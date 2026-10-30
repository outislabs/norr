import type { CryptoSignals, RegistryEntry } from "@norr/core";
import { obj, requestJson, type FetchLike } from "./http";

/** 1Click chain names mapped to DexScreener chain ids. Unmapped chains yield unknown signals. */
export const DEXSCREENER_CHAINS: Record<string, string> = {
  sol: "solana", eth: "ethereum", bsc: "bsc", base: "base", arb: "arbitrum", near: "near", pol: "polygon", op: "optimism",
  avax: "avalanche", tron: "tron", ton: "ton", sui: "sui", aptos: "aptos", gnosis: "gnosischain", xlayer: "xlayer",
  bera: "berachain", monad: "monad", starknet: "starknet", scroll: "scroll",
};

export interface DexScreenerOptions {
  fetch?: FetchLike;
  now?: () => number;
  /** How long a lookup is reused. DexScreener responses are cached for 30 s upstream. */
  ttlMs?: number;
}

/**
 * Read-only market signals for Scam Shield from DexScreener (https://docs.dexscreener.com), which
 * needs no API key. Liquidity is summed over the token's pools on its own chain; market cap falls
 * back to FDV; age is the oldest pool. Anything missing is null, which Scam Shield scores as a risk.
 */
export class DexScreenerSignals {
  private readonly f: FetchLike;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { at: number; value: CryptoSignals }>();

  constructor(o: DexScreenerOptions = {}) {
    this.f = o.fetch ?? ((url, init) => fetch(url, init));
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? 60_000;
  }

  /** Usable directly as the `signals` function of `HeuristicRiskProvider`. */
  signals = async (asset: RegistryEntry): Promise<CryptoSignals> => {
    const unknown: CryptoSignals = { routable: true, liquidityUsd: null, marketCapUsd: null, ageDays: null };
    const chain = DEXSCREENER_CHAINS[asset.chain];
    if (!chain || !asset.contractAddress) return unknown;

    const key = `${chain}:${asset.contractAddress.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;

    let value = unknown;
    try {
      const url = `https://api.dexscreener.com/tokens/v1/${chain}/${encodeURIComponent(asset.contractAddress)}`;
      const body = await requestJson(this.f, url, { headers: { "user-agent": "norr/0.1" } }, "DexScreener");
      value = Array.isArray(body) ? this.summarize(body, asset.contractAddress) : unknown;
    } catch {
      return unknown; // not cached: try again next time
    }
    this.cache.set(key, { at: this.now(), value });
    return value;
  };

  private summarize(pairs: unknown[], contract: string): CryptoSignals {
    const mine = pairs.map(obj).filter((p) => String(obj(p.baseToken).address).toLowerCase() === contract.toLowerCase());
    if (mine.length === 0) return { routable: true, liquidityUsd: null, marketCapUsd: null, ageDays: null };
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const liq = mine.map((p) => num(obj(p.liquidity).usd)).filter((n): n is number => n !== null);
    const caps = mine.map((p) => num(p.marketCap) ?? num(p.fdv)).filter((n): n is number => n !== null);
    const created = mine.map((p) => num(p.pairCreatedAt)).filter((n): n is number => n !== null);
    return {
      routable: true,
      liquidityUsd: liq.length ? liq.reduce((a, b) => a + b, 0) : null,
      marketCapUsd: caps.length ? Math.max(...caps) : null,
      ageDays: created.length ? Math.floor((this.now() - Math.min(...created)) / 86_400_000) : null,
    };
  }
}
