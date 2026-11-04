/**
 * Contract-level token checks for Scam Shield, from GoPlus Security (https://docs.gopluslabs.io), alongside the
 * market data (liquidity, market cap, age). Pure: the fetching lives in @norr/intents (GoPlusClient).
 *
 * What GoPlus covers: EVM chains by chain id and Solana. A NEAR Intents asset is looked up through the underlying
 * token it represents (the 1Click token list gives its chain and contract address). Anything that cannot be checked
 * (no mapping, no data, GoPlus unreachable) is said so in the reasons and adds a little risk; it never passes silently.
 */

/** GoPlus's raw answer for one token, reduced to the fields Norr scores. Strings as GoPlus sends them ("1" = true). */
export interface EvmTokenSecurity {
  is_honeypot?: string;
  cannot_buy?: string;
  cannot_sell_all?: string;
  is_blacklisted?: string;
  is_mintable?: string;
  owner_change_balance?: string;
  hidden_owner?: string;
  selfdestruct?: string;
  transfer_pausable?: string;
  can_take_back_ownership?: string;
  slippage_modifiable?: string;
  buy_tax?: string;
  sell_tax?: string;
  is_open_source?: string;
  is_proxy?: string;
  trust_list?: string;
  is_airdrop_scam?: string;
  owner_address?: string;
}

/** Ownership given up for good: the owner is the zero or dead address. An empty owner means unknown, not renounced. */
const RENOUNCED = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);

interface SolanaAuthority {
  status?: string;
}
export interface SolanaTokenSecurity {
  mintable?: SolanaAuthority;
  freezable?: SolanaAuthority;
  closable?: SolanaAuthority;
  balance_mutable_authority?: SolanaAuthority;
  none_transferable?: string;
  transfer_fee?: { current_fee_rate?: { fee_rate?: string | number } };
  transfer_hook?: unknown[];
  trusted_token?: number | string;
}

export type ContractCheck =
  | { status: "ok"; source: "goplus"; family: "evm"; chainId: string; address: string; data: EvmTokenSecurity }
  | { status: "ok"; source: "goplus"; family: "solana"; address: string; data: SolanaTokenSecurity }
  | { status: "not_covered"; reason: string }
  | { status: "no_data"; address: string }
  | { status: "unreachable"; error: string };

export interface ContractFinding {
  /** Plain-language finding, shown to owners and agents. */
  text: string;
  points: number;
}

/** What the agent, the owner and the dashboard see about a token's contract. */
export interface ContractSummary {
  source: "goplus";
  status: ContractCheck["status"];
  trusted: boolean;
  findings: string[];
}

const yes = (v: unknown) => v === "1" || v === 1;
const tax = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

function taxFinding(kind: "Buy" | "Sell" | "Transfer", t: number | null): ContractFinding[] {
  if (t === null || t <= 0.1) return [];
  return [{ text: `${kind} tax is ${pct(t)}.`, points: t > 0.5 ? 60 : 30 }];
}

/** Score one GoPlus result. Points add to the Scam Shield score; the texts become reasons. */
export function contractFindings(c: ContractCheck): { findings: ContractFinding[]; trusted: boolean } {
  switch (c.status) {
    case "not_covered":
      return { findings: [{ text: `Contract checks (GoPlus): not checked, ${c.reason}.`, points: 10 }], trusted: false };
    case "no_data":
      return { findings: [{ text: "Contract checks (GoPlus): no data for this contract, so it was not checked.", points: 15 }], trusted: false };
    case "unreachable":
      return { findings: [{ text: "Contract checks (GoPlus): the service could not be reached, so the contract was not checked.", points: 15 }], trusted: false };
  }
  const f: ContractFinding[] = [];
  if (c.family === "evm") {
    const d = c.data;
    const trusted = yes(d.trust_list);
    if (yes(d.is_honeypot)) f.push({ text: "Honeypot: holders cannot sell it.", points: 100 });
    if (yes(d.cannot_sell_all)) f.push({ text: "Holders cannot sell all of their tokens.", points: 60 });
    if (yes(d.cannot_buy)) f.push({ text: "It cannot be bought.", points: 40 });
    if (yes(d.is_airdrop_scam)) f.push({ text: "Flagged as an airdrop scam.", points: 80 });
    if (!trusted) {
      // Owner-only functions cannot be used once ownership is renounced for good (and cannot be taken back, and no
      // hidden owner remains). GoPlus reports that the functions exist, so this is what decides whether they matter.
      const renounced = RENOUNCED.has((d.owner_address ?? "").toLowerCase()) && !yes(d.can_take_back_ownership) && !yes(d.hidden_owner);
      const ownerOnly = [
        [d.owner_change_balance, "The owner can change holders' balances.", 50],
        [d.is_blacklisted, "The owner can blacklist addresses.", 25],
        [d.transfer_pausable, "Transfers can be paused by the owner.", 25],
        [d.is_mintable, "The owner can mint more tokens.", 20],
        [d.slippage_modifiable, "The owner can change the trading tax.", 20],
      ] as const;
      if (renounced && ownerOnly.some(([v]) => yes(v))) f.push({ text: "Ownership is renounced, so owner-only functions in the contract (such as blacklisting or pausing) can no longer be used.", points: 0 });
      if (!renounced) for (const [v, text, points] of ownerOnly) if (yes(v)) f.push({ text, points });
      if (yes(d.selfdestruct)) f.push({ text: "The contract can self-destruct.", points: 40 });
      if (yes(d.hidden_owner)) f.push({ text: "The contract has a hidden owner.", points: 30 });
      if (yes(d.can_take_back_ownership)) f.push({ text: "Ownership can be taken back after renouncing.", points: 25 });
      if (d.is_open_source === "0") f.push({ text: "The contract source is not verified (closed source).", points: 20 });
      if (yes(d.is_proxy)) f.push({ text: "The contract is a proxy: its code can be replaced.", points: 10 });
    }
    f.push(...taxFinding("Buy", tax(d.buy_tax)), ...taxFinding("Sell", tax(d.sell_tax)));
    return { findings: f, trusted };
  }
  const d = c.data;
  const trusted = yes(d.trusted_token);
  if (d.none_transferable === "1") f.push({ text: "The token cannot be transferred.", points: 60 });
  if (!trusted) {
    if (yes(d.balance_mutable_authority?.status)) f.push({ text: "An authority can change holders' balances.", points: 50 });
    if (yes(d.freezable?.status)) f.push({ text: "Freeze authority is active: holders' accounts can be frozen.", points: 25 });
    if (yes(d.mintable?.status)) f.push({ text: "Mint authority is active: more tokens can be minted.", points: 20 });
    if (yes(d.closable?.status)) f.push({ text: "The mint can be closed by an authority.", points: 15 });
    if (Array.isArray(d.transfer_hook) && d.transfer_hook.length > 0) f.push({ text: "A transfer hook runs custom code on every transfer.", points: 20 });
  }
  f.push(...taxFinding("Transfer", tax(d.transfer_fee?.current_fee_rate?.fee_rate)));
  return { findings: f, trusted };
}

export function contractSummary(c: ContractCheck): ContractSummary {
  const { findings, trusted } = contractFindings(c);
  const texts = findings.map((x) => x.text);
  if (c.status === "ok" && texts.length === 0) texts.push(trusted ? "On GoPlus's trusted list; no contract risks found." : "No contract risks found.");
  else if (c.status === "ok" && trusted) texts.unshift("On GoPlus's trusted list.");
  return { source: "goplus", status: c.status, trusted, findings: texts };
}
