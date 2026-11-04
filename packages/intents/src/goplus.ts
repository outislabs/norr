import type { ContractCheck, RegistryEntry } from "@norr/core";
import { obj, type FetchLike } from "./http";

/**
 * GoPlus Security token checks (https://docs.gopluslabs.io): honeypot, owner privileges, mint/freeze authority,
 * blacklist, taxes. Used without an API key, one token per request (the documented keyless behaviour returns one
 * result per call), cached for 10 minutes. GoPlus documents no free-tier rate limit or terms page we could find
 * (checked 2026-11-04); 8 quick keyless calls were all answered.
 *
 * NEAR Intents assets are looked up through the token they represent: 1Click's token list gives each asset's own
 * chain and contract address. EVM chains go by chain id, Solana has its own endpoint, everything else (NEAR-native
 * tokens, Bitcoin, TON...) is "not covered" and the reason says so.
 */
export const GOPLUS_EVM_CHAINS: Record<string, string> = { eth: "1", bsc: "56", base: "8453", arb: "42161", pol: "137", op: "10", avax: "43114" };
const BASE = "https://api.gopluslabs.io/api/v1";

export interface GoPlusOptions {
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  baseUrl?: string;
}

export class GoPlusClient {
  private readonly f: FetchLike;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly base: string;
  private readonly cache = new Map<string, { at: number; value: ContractCheck }>();

  constructor(o: GoPlusOptions = {}) {
    this.f = o.fetch ?? ((url, init) => fetch(url, init));
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? 10 * 60_000;
    this.timeoutMs = o.timeoutMs ?? 8_000;
    this.base = (o.baseUrl ?? BASE).replace(/\/+$/, "");
  }

  /** Never throws: an unreachable or unexpected answer becomes "unreachable", a missing mapping "not_covered". */
  check = async (asset: RegistryEntry): Promise<ContractCheck> => {
    const address = asset.contractAddress?.trim();
    const chainId = GOPLUS_EVM_CHAINS[asset.chain];
    const solana = asset.chain === "sol";
    if (!address) return { status: "not_covered", reason: "the asset has no contract address in the NEAR Intents token list (a native coin or a NEAR-native token)" };
    if (!chainId && !solana) return { status: "not_covered", reason: `GoPlus does not cover the ${asset.chain} chain` };
    const evmAddress = chainId && /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : null;
    if (chainId && !evmAddress) return { status: "not_covered", reason: `"${address}" is not an EVM contract address` };
    const key = `${asset.chain}:${evmAddress ?? address}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;

    const url = solana
      ? `${this.base}/solana/token_security?contract_addresses=${encodeURIComponent(address)}`
      : `${this.base}/token_security/${chainId}?contract_addresses=${encodeURIComponent(evmAddress!)}`;
    let value: ContractCheck;
    try {
      const res = await this.f(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = obj(await res.json());
      if (body.code !== 1) throw new Error(`GoPlus code ${String(body.code)}: ${String(body.message ?? "")}`);
      const result = obj(body.result);
      const found = (solana ? result[address] : result[evmAddress!]) as Record<string, unknown> | undefined;
      if (!found || Object.keys(found).length === 0) value = { status: "no_data", address };
      else value = solana ? { status: "ok", source: "goplus", family: "solana", address, data: found } : { status: "ok", source: "goplus", family: "evm", chainId: chainId!, address: evmAddress!, data: found };
    } catch (e) {
      // Not cached: the next request tries again.
      return { status: "unreachable", error: e instanceof Error ? e.message : String(e) };
    }
    this.cache.set(key, { at: this.now(), value });
    return value;
  };
}
