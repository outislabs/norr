import { obj, requestJson, type FetchLike } from "./http";

export interface BalanceReader {
  /** Every token the account holds inside Intents: asset id to smallest units. */
  holdings(account: string): Promise<Record<string, string>>;
}

export interface NearIntentsBalancesOptions {
  rpcUrl?: string;
  fetch?: FetchLike;
}

/** Reads a vault's Intents balances straight from `intents.near` (view calls only). */
export class NearIntentsBalances implements BalanceReader {
  private readonly rpc: string;
  private readonly f: FetchLike;

  constructor(o: NearIntentsBalancesOptions = {}) {
    this.rpc = o.rpcUrl ?? "https://rpc.mainnet.fastnear.com";
    this.f = o.fetch ?? ((url, init) => fetch(url, init));
  }

  private async view(method: string, args: unknown): Promise<unknown> {
    const body = {
      jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "call_function", finality: "final", account_id: "intents.near", method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    };
    const res = obj(await requestJson(this.f, this.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, "NEAR RPC"));
    const bytes = obj(res.result).result;
    if (!Array.isArray(bytes)) throw new Error("NEAR RPC: view call failed");
    return JSON.parse(Buffer.from(bytes as number[]).toString("utf8"));
  }

  async holdings(account: string): Promise<Record<string, string>> {
    const owned = await this.view("mt_tokens_for_owner", { account_id: account });
    const ids = Array.isArray(owned) ? owned.map((t) => String(obj(t).token_id)) : [];
    if (ids.length === 0) return {};
    const balances = await this.view("mt_batch_balance_of", { account_id: account, token_ids: ids });
    const out: Record<string, string> = {};
    ids.forEach((id, i) => {
      const b = Array.isArray(balances) ? String(balances[i] ?? "0") : "0";
      if (b !== "0") out[id] = b;
    });
    return out;
  }
}
