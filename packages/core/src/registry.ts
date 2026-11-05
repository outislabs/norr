import type { Asset } from "@norr/shared";

/** The subset of a 1Click `/v0/tokens` entry that Norr uses. */
export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
  coingeckoId?: string;
  /** Token contract on its own chain; used to look up market data. */
  contractAddress?: string;
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
  contractAddress: string | null;
}

export interface Resolution {
  class: Asset["class"];
  ticker: string;
  /** Every routable version of what the agent asked for (several issuers or chains). */
  candidates: RegistryEntry[];
  /** Several different tokens share this symbol (different CoinGecko ids): never pick one by price. */
  ambiguous?: true;
  /** Resolved from a chain and contract address: exactly one token. */
  byContract?: true;
}

/** A token named by chain and contract address ("base:0x8335…", "sol:EPjF…", "near:wrap.near"). */
export interface ContractRef {
  chain: string;
  address: string;
}

/** What a query names: a known asset (possibly ambiguous), a contract the catalog does not route, or nothing. */
export type Lookup = { kind: "found"; resolution: Resolution } | { kind: "not_routable"; ref: ContractRef } | { kind: "unknown" };

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Same contract? EVM addresses compare case-insensitively; every other chain's addresses are case-sensitive. */
export const sameAddress = (a: string, b: string): boolean => (EVM_ADDRESS.test(a) && EVM_ADDRESS.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b);

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
    contractAddress: t.contractAddress ?? null,
  };
}

/** Unified asset list. Pure: callers fetch the token lists, the registry only indexes them. */
export class Registry {
  private readonly byIdMap = new Map<string, RegistryEntry>();

  constructor(input: RegistryInput) {
    this.load(input);
  }

  /** Replaces the whole list, for a service that starts before the token list is reachable and fills the registry once it is. */
  load(input: RegistryInput): void {
    this.byIdMap.clear();
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
  /** The chains the catalog covers (1Click's blockchain names). */
  chains(): Set<string> {
    return new Set(this.entries().map((e) => e.chain));
  }

  /** "chain:address" with a chain the catalog knows, else null. Asset ids ("nep141:…") are not contract refs. */
  parseContractRef(query: string): ContractRef | null {
    const m = /^([a-z0-9-]+):(\S{2,128})$/.exec(query.trim());
    if (!m || this.byIdMap.has(query.trim()) || !this.chains().has(m[1]!)) return null;
    return { chain: m[1]!, address: m[2]! };
  }

  /** Resolve a query, telling apart an unroutable contract and an ambiguous symbol. */
  lookup(query: string): Lookup {
    const ref = this.parseContractRef(query);
    if (ref) {
      const hit = this.entries().filter((e) => e.chain === ref.chain && e.contractAddress && sameAddress(e.contractAddress, ref.address));
      if (hit.length === 0) return { kind: "not_routable", ref };
      const e = hit[0]!;
      return { kind: "found", resolution: { class: e.class, ticker: e.ticker, candidates: hit.slice(0, 1), byContract: true } };
    }
    const r = this.resolve(query);
    return r ? { kind: "found", resolution: r } : { kind: "unknown" };
  }

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
      // Look-alikes: crypto versions of one symbol must be the same token (one CoinGecko id). Otherwise a symbol alone
      // cannot say which token is meant, and picking the best quote could buy the wrong one.
      const ids = new Set(picked.map((e) => e.coingeckoId ?? `unknown:${e.id}`));
      const ambiguous = first.class === "crypto" && picked.length > 1 && ids.size > 1;
      return { class: first.class, ticker: first.ticker, candidates: picked, ...(ambiguous ? { ambiguous: true as const } : {}) };
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
