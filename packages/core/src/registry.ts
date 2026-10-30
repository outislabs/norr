import type { Asset } from "@norr/shared";

/** The subset of a 1Click `/v0/tokens` entry that Norr uses. */
export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
  coingeckoId?: string;
}

/** An equity issuer. Tokens are named `<TICKER><suffix>` (Ondo: NVDAon, xStocks: NVDAx). */
export interface EquityIssuer {
  id: string;
  suffix: string;
}

export const ONDO: EquityIssuer = { id: "ondo", suffix: "on" };
export const XSTOCKS: EquityIssuer = { id: "xstocks", suffix: "x" };

export interface RegistryEntry extends Asset {
  ticker: string; // equities: "NVDA"; crypto: the symbol
  issuer: string | null; // null for crypto
  priceUsd: number | null;
  coingeckoId: string | null;
}

export interface Resolution {
  class: Asset["class"];
  ticker: string;
  /** Every routable version of what the agent asked for (several issuers or chains). */
  candidates: RegistryEntry[];
}

export interface RegistryInput {
  crypto: OneClickToken[];
  equities?: { issuer: EquityIssuer; tokens: OneClickToken[] }[];
}

/** `/v0/tokens?ondoTokens=true` returns the plain list plus extras. Keep only the extras. */
export function extraTokens(plain: OneClickToken[], withExtras: OneClickToken[]): OneClickToken[] {
  const known = new Set(plain.map((t) => t.assetId));
  return withExtras.filter((t) => !known.has(t.assetId));
}

function tickerOf(symbol: string, suffix: string): string {
  const up = symbol.toUpperCase();
  const suf = suffix.toUpperCase();
  return up.endsWith(suf) && up.length > suf.length ? up.slice(0, -suf.length) : up;
}

function toEntry(t: OneClickToken, cls: Asset["class"], issuer: EquityIssuer | null): RegistryEntry {
  return {
    id: t.assetId,
    symbol: t.symbol,
    name: t.symbol,
    class: cls,
    chain: t.blockchain,
    decimals: t.decimals,
    ticker: issuer ? tickerOf(t.symbol, issuer.suffix) : t.symbol.toUpperCase(),
    issuer: issuer?.id ?? null,
    priceUsd: t.price ?? null,
    coingeckoId: t.coingeckoId ?? null,
  };
}

/** Unified asset list. Pure: callers fetch the token lists, the registry only indexes them. */
export class Registry {
  private readonly byIdMap = new Map<string, RegistryEntry>();

  constructor(input: RegistryInput) {
    for (const t of input.crypto) this.byIdMap.set(t.assetId, toEntry(t, "crypto", null));
    // Equity entries win if an id appears in both lists.
    for (const { issuer, tokens } of input.equities ?? []) {
      for (const t of tokens) this.byIdMap.set(t.assetId, toEntry(t, "equity", issuer));
    }
  }

  entries(cls?: Asset["class"]): RegistryEntry[] {
    const all = [...this.byIdMap.values()];
    return cls ? all.filter((e) => e.class === cls) : all;
  }

  byId(id: string): RegistryEntry | undefined {
    return this.byIdMap.get(id);
  }

  /**
   * Resolve what an agent typed: an asset id, an exact symbol ("NVDAon", "SOL"), or an
   * equity ticker ("NVDA", which maps to every issuer's version). Unknown returns null.
   */
  resolve(query: string): Resolution | null {
    const q = query.trim();
    if (!q) return null;

    const exact = this.byIdMap.get(q);
    if (exact) return { class: exact.class, ticker: exact.ticker, candidates: [exact] };

    const up = q.toUpperCase();
    const bySymbol = this.entries().filter((e) => e.symbol.toUpperCase() === up);
    if (bySymbol.length > 0) {
      const crypto = bySymbol.filter((e) => e.class === "crypto");
      const picked = crypto.length > 0 ? crypto : bySymbol;
      const first = picked[0]!;
      return { class: first.class, ticker: first.ticker, candidates: picked };
    }

    const byTicker = this.entries("equity").filter((e) => e.ticker === up);
    if (byTicker.length > 0) return { class: "equity", ticker: up, candidates: byTicker };
    return null;
  }
}

/** A dry or real quote reduced to what routing needs. */
export interface CandidateQuote {
  assetId: string;
  issuer: string | null;
  amountInUsd: number;
  amountOutUsd: number;
}

/** Best quote = the most USD value out. Candidates with no quote are simply absent. */
export function selectBestQuote(quotes: CandidateQuote[]): CandidateQuote | null {
  let best: CandidateQuote | null = null;
  for (const q of quotes) {
    if (!Number.isFinite(q.amountOutUsd) || q.amountOutUsd <= 0) continue;
    if (!best || q.amountOutUsd > best.amountOutUsd) best = q;
  }
  return best;
}
