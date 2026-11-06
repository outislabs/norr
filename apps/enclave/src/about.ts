import { incidentFeedInfo } from "@norr/core";
import type { Vault } from "./state";
import type { TradeDeps } from "./trade";

/**
 * What an agent should know about how Norr works, stated from the running service (not from marketing): custody,
 * approvals, privacy, what is stored, attestation, the incident feed. Served on GET /v1/about (MCP tool about_norr), and
 * the approval part is attached to every quote and pending trade. Keep it factual and short; docs/PRIVACY.md is the source.
 */

export const APPROVAL_TTL_HOURS = 24;

export interface ApprovalInfo {
  /** true: every swap waits for the owner; false: swaps run within the custody limits; null: unknown right now. */
  required: boolean | null;
  mode: "owner" | "autonomous" | "none" | "unknown";
  where: string;
  url: string | null;
  expiresHours: number;
  note: string;
}

/** Keyed by the vault's custody client, so a rebuilt client (another wallet) never inherits an old answer. */
const cache = new WeakMap<object, { at: number; mode: ApprovalInfo["mode"] }>();
const CACHE_MS = 15 * 60_000; // each read is a custody-provider call, and the free tier counts operations per wallet

/** The vault's approval mode, read from the custody provider's own policy (authoritative), cached. */
export async function approvalInfo(deps: Pick<TradeDeps, "now" | "dashboardUrl">, vault: Pick<Vault, "id" | "custody">): Promise<ApprovalInfo> {
  const hit = cache.get(vault.custody);
  let mode: ApprovalInfo["mode"];
  if (hit && deps.now() - hit.at < CACHE_MS) mode = hit.mode;
  else {
    mode = vault.custody.approvalMode ? await vault.custody.approvalMode().catch(() => "unknown" as const) : "unknown";
    if (mode !== "unknown") cache.set(vault.custody, { at: deps.now(), mode });
  }
  const url = deps.dashboardUrl ? `${deps.dashboardUrl.replace(/\/+$/, "")}/#/vault/${encodeURIComponent(vault.id)}/approvals` : null;
  const where = "Norr dashboard, the vault's Approvals tab";
  const note =
    mode === "owner"
      ? `Every swap in this vault waits for the owner's approval in the ${where}${url ? ` (${url})` : ""}. An approval expires after ${APPROVAL_TTL_HOURS} hours. Tell the owner, then follow up with get_activity; do not resend.`
      : mode === "autonomous"
        ? "Swaps run without the owner's signature, inside the custody provider's limits. Withdrawals still go only to the owner."
        : mode === "none"
          ? "The custody policy sets no approval step."
          : `Could not read the custody policy just now; a swap may wait for the owner's approval in the ${where}.`;
  return { required: mode === "owner" ? true : mode === "unknown" ? null : false, mode, where, url, expiresHours: APPROVAL_TTL_HOURS, note };
}

/** Forget a vault's cached mode (the owner changed the policy). */
export const forgetApprovalMode = (vault: Pick<Vault, "custody">): void => void cache.delete(vault.custody);

export interface AboutContext {
  attested: boolean;
  commit: string | null;
  verifyUrl: string;
  selfServe: boolean;
}

export async function aboutNorr(deps: TradeDeps, vault: Vault, ctx: AboutContext) {
  const approval = await approvalInfo(deps, vault);
  const feed = incidentFeedInfo(deps.incidentFeed ?? "active");
  return {
    what: "Norr is a private trading layer for AI agents: you trade crypto and tokenized stocks for one vault through NEAR Intents, inside rules the vault's owner sets.",
    custody: {
      provider: "OutLayer Agent Custody: the vault is a custody wallet whose keys live in OutLayer's TEE.",
      control: ctx.selfServe && vault.id.startsWith("v_")
        ? `The owner's NEAR account (${vault.owner}) stored the custody policy on chain and is its controller: only the owner can change or freeze it. Norr cannot.`
        : `The custody policy is set by the owner (${vault.owner}) at the custody provider; neither you nor Norr can change it.`,
      you: "You hold a token for this one vault. You can read it, get quotes and trade within its rules. You cannot withdraw, change rules, or choose where funds go: trades always settle back into the vault, and withdrawals go only to the owner's whitelisted account.",
      trust: "Custody is not trustless: for swaps, OutLayer's gateway builds the route and its TEE does not re-check token or amount. Norr checks every result afterwards and pauses the vault on a mismatch.",
    },
    approvals: approval,
    autonomousMode: {
      what: "Optional and off by default. The vault's owner turns it on or off in Rules (one wallet signature); approvals.mode says which applies to this vault right now.",
      whenOn: "Your swaps run without the owner's signature, but still only within the vault's largest trade, daily spending cap, daily loss cap, cooldown and operations-per-hour limit. A trade over a limit is refused (blocked), not queued for approval.",
      money: "Money can only reach the owner's whitelisted address, with autonomous mode on or off: withdrawals and transfers go only there, and swaps settle back into the vault.",
    },
    privacy: {
      confidential: "Trades run in NEAR Intents' confidential layer when the vault's funds are there (each answer's 'venue' says which): amounts, pairs and balances are not on the public chain.",
      whoSees: "Not private from: OutLayer (it builds and signs each operation), the NEAR Intents operator and solvers (they see confidential intents in plaintext), and the Norr service (it must read trades to enforce the rules). Funding, withdrawals and moves between the public and confidential layers are public on chain.",
    },
    operator: {
      insideTheEnclave: "Inside the enclave the Norr service handles your requests, balances, positions, rules and the ledger in plaintext. It sees the 'reason' you send only until it seals it to the owner's key.",
      operatorCannot: "The operator who runs Norr cannot read the sealed reasoning (only the owner's key opens it), cannot change a self-serve vault's custody policy (the owner controls it on chain), and cannot send money anywhere but the owner's whitelisted address; swaps wait for the owner's approval unless the owner turned on autonomous mode.",
      today: "Today the operator holds the key that encrypts Norr's stored data. The production image has no shell and logs are private, so there is no ordinary way to read it, but the operator could decrypt a copy of the data, or deploy changed code (every deployed version is visible through attestation). Moving that key into the enclave is proposed, not built (docs/OPERATOR-PRIVACY.md).",
      others: "OutLayer sees every custody operation it builds and signs. The NEAR Intents operator and solvers see confidential intents in plaintext.",
    },
    storage: {
      reasoning: "The 'reason' you give with a trade is sealed to the owner's key: only the owner can read it, not Norr's operator.",
      ledger: "Norr keeps each request and its outcome (asset, amount, decision) in a ledger encrypted at rest inside the service; the service reads it to enforce caps, and get_activity shows it to you.",
      notLogged: "Request bodies, balances, positions and rules are not written to logs; the deployment runs with private logs. Agent tokens are stored only as hashes.",
    },
    attestation: ctx.attested
      ? { status: `The service runs in an Intel TDX confidential VM (Phala Cloud) on code commit ${ctx.commit ?? "unknown"}; anyone can verify it.`, verifyUrl: ctx.verifyUrl }
      : { status: "This service is not running in a TEE (local or mock mode): there is no attestation.", verifyUrl: ctx.verifyUrl },
    incidentFeed: feed,
    docs: "https://norr.finance/docs/",
  };
}
