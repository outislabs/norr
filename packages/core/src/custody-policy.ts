/**
 * The custody policy Norr proposes for a new vault, in OutLayer's policy format (`EncryptPolicyRequest` in
 * api.outlayer.ai/openapi.json), and the check that what OutLayer holds is that policy. Pure.
 *
 * The owner's own wallet stores it on chain (`store_wallet_policy` on outlayer.near), which makes the owner the wallet's
 * controller for good: only the owner can change or freeze it afterwards (docs/MULTI-USER.md).
 */
import { unitsForUsd } from "./funding-sources";

export interface PolicyAsset {
  /** Defuse asset id, e.g. "nep141:sol.omft.near". */
  id: string;
  decimals: number;
  priceUsd: number;
}

export interface CustodyPolicyInput {
  /** The vault owner's NEAR account: the only approver, the controller, and a whitelisted destination. */
  owner: string;
  /** The vault's own account at the custody provider (its implicit account). */
  walletAccount: string;
  /** Cash (USDC) and the assets the vault may hold. Duplicates are ignored. */
  assets: PolicyAsset[];
  maxTradeUsd: number;
  dailyCapUsd: number;
  /** Skip the owner's approval for confidential operations (swaps, but also transfers to whitelisted accounts). Off by default. */
  autonomous: boolean;
  /** Room above the USD caps when converted to token units, for price moves between today and a trade. Default 1.25. */
  headroom?: number;
  /** Operations per hour. Default 10. */
  maxPerHour?: number;
}

export interface CustodyPolicy {
  rules: {
    transaction_types: string[];
    allowed_tokens: string[];
    addresses: { mode: "whitelist"; list: string[] };
    limits: { per_transaction: Record<string, string>; hourly: Record<string, string>; daily: Record<string, string> };
    rate_limit: { max_per_hour: number };
  };
  approval: { threshold: { required: number }; approvers: { id: string; role: "admin" | "signer" }[]; excluded_types?: string[] };
  capabilities: Record<string, { allowed: boolean }>;
}

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** The safe default: confidential operations only, owner-only destinations, owner approval, tight limits. */
export function buildCustodyPolicy(i: CustodyPolicyInput): CustodyPolicy {
  if (!ACCOUNT.test(i.owner) || i.owner.length < 2 || i.owner.length > 64) throw new Error("owner must be a NEAR account id");
  if (!/^[0-9a-f]{64}$/.test(i.walletAccount)) throw new Error("walletAccount must be the wallet's implicit account (64 hex characters)");
  if (!(i.maxTradeUsd > 0) || !(i.dailyCapUsd >= i.maxTradeUsd)) throw new Error("caps must be positive, and the daily cap at least the trade size");
  const headroom = i.headroom ?? 1.25;
  const assets = [...new Map(i.assets.map((a) => [a.id, a])).values()].filter((a) => a.priceUsd > 0);
  if (assets.length === 0) throw new Error("at least one priced asset is required");
  const perTx: Record<string, string> = {};
  const daily: Record<string, string> = {};
  for (const a of assets) {
    perTx[a.id] = unitsForUsd(i.maxTradeUsd * headroom, a.priceUsd, a.decimals);
    daily[a.id] = unitsForUsd(i.dailyCapUsd * headroom, a.priceUsd, a.decimals);
  }
  return {
    rules: {
      transaction_types: ["confidential"],
      allowed_tokens: assets.map((a) => a.id),
      addresses: { mode: "whitelist", list: [i.owner, i.walletAccount] },
      limits: { per_transaction: perTx, hourly: { ...daily }, daily },
      rate_limit: { max_per_hour: i.maxPerHour ?? 10 },
    },
    approval: { threshold: { required: 1 }, approvers: [{ id: i.owner, role: "admin" }], ...(i.autonomous ? { excluded_types: ["confidential"] } : {}) },
    capabilities: { confidential: { allowed: true }, evm_sign: { allowed: false }, solana_sign: { allowed: false } },
  };
}

/** The policy in plain words, for the owner to read before signing. */
export function describeCustodyPolicy(p: CustodyPolicy, maxTradeUsd: number, dailyCapUsd: number): string[] {
  return [
    "Only confidential operations are allowed (swaps, deposits and withdrawals inside the confidential layer).",
    `Money can only be sent to ${p.rules.addresses.list[0]} or stay in the vault (${(p.rules.addresses.list[1] ?? "").slice(0, 8)}…).`,
    p.approval.excluded_types?.includes("confidential")
      ? `Autonomous: operations run without your signature, within the limits. Withdrawals still go only to ${p.rules.addresses.list[0]}.`
      : `Every operation waits for your approval, signed by ${p.approval.approvers[0]!.id}, in Norr's Approvals tab.`,
    `Limits per operation and per day, in each token: about $${maxTradeUsd} and $${dailyCapUsd} at today's prices, plus 25% for price moves.`,
    `At most ${p.rules.rate_limit.max_per_hour} operations per hour.`,
    `${p.approval.approvers[0]!.id} becomes the wallet's controller: only you can change or freeze this policy, and Norr cannot.`,
  ];
}

/** What differs between the policy Norr proposed and the one the custody provider holds. Empty means it is that policy. */
export function custodyPolicyProblems(expected: CustodyPolicy, actual: unknown): string[] {
  const a = (actual ?? {}) as Partial<CustodyPolicy> & { frozen?: boolean };
  const problems: string[] = [];
  const same = (x: unknown, y: unknown) => JSON.stringify(sortDeep(x)) === JSON.stringify(sortDeep(y));
  if (!a.rules) return ["The custody provider holds no policy for this wallet."];
  if (!same(a.rules.transaction_types, expected.rules.transaction_types)) problems.push("Allowed operation types differ.");
  if (!same(a.rules.addresses, expected.rules.addresses)) problems.push("The address whitelist differs.");
  if (!same(a.rules.allowed_tokens, expected.rules.allowed_tokens)) problems.push("Allowed tokens differ.");
  if (!same(a.rules.limits, expected.rules.limits)) problems.push("Limits differ.");
  if (!same(a.rules.rate_limit, expected.rules.rate_limit)) problems.push("The rate limit differs.");
  const approval = a.approval ?? ({} as CustodyPolicy["approval"]);
  if (!same({ ...approval, excluded_types: approval.excluded_types ?? [] }, { ...expected.approval, excluded_types: expected.approval.excluded_types ?? [] })) problems.push("Approvers or approval settings differ.");
  if (!same(a.capabilities, expected.capabilities)) problems.push("Capabilities differ.");
  if (a.frozen) problems.push("The wallet is frozen.");
  return problems;
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, sortDeep(x)]));
  return v;
}
