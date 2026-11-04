/**
 * In-dashboard approvals for the custody provider's multisig (OutLayer). The browser fetches each approval straight
 * from the provider, recomputes the hash the owner will sign, compares the operation with what Norr asked for, and
 * sends the owner's signed vote straight back to the provider. Norr only lists the approval ids; it can change neither
 * what is shown nor what is signed.
 *
 * OutLayer's rule (docs/agent-custody, the API spec): request_hash = sha256(op_canonical); a vote is a NEP-413
 * signature over "approve:{approval_id}:{wallet_pubkey}:{request_hash}" (or "reject:..."), recipient "outlayer.near".
 */

export interface ApprovalDetail {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  request_type: string;
  request_hash: string;
  op_canonical?: string | null;
  op?: unknown;
  wallet_pubkey?: string | null;
  expires_at: string;
}

/** What Norr asked the custody provider for, in its smallest units. */
export interface Intended {
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  minAmountOut: string;
}

export type VoteKind = "approve" | "reject";

export const voteMessage = (kind: VoteKind, approvalId: string, walletPubkey: string, requestHash: string): string => `${kind}:${approvalId}:${walletPubkey}:${requestHash}`;

/** "service:/mock-outlayer" (mock mode) resolves against the Norr service's base; anything else is the provider's URL. */
export const resolveApprovalsBase = (approvalsApi: string, apiBase: string): string => (approvalsApi.startsWith("service:") ? `${apiBase.replace(/\/+$/, "")}${approvalsApi.slice("service:".length)}` : approvalsApi.replace(/\/+$/, ""));

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every string and number inside a value, flattened, for a format-agnostic comparison with Norr's record. */
function leaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") out.push(String(v));
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, out));
  return out;
}

export interface ApprovalCheck {
  /** sha256(op_canonical) equals the hash the vote would sign. */
  hashMatches: boolean;
  /** The operation names what Norr asked for (null when Norr has no record of this approval). */
  matchesNorr: boolean | null;
  /** Plain reasons, shown next to the buttons. */
  problems: string[];
  /** The operation as the provider describes it, parsed for display. */
  op: unknown;
}

/** The two checks that gate the Approve button. Pure apart from hashing. */
export async function checkApproval(d: ApprovalDetail, intended: Intended | null, nowMs = Date.now()): Promise<ApprovalCheck> {
  const problems: string[] = [];
  let op: unknown = d.op ?? null;
  let hashMatches = false;
  if (!d.op_canonical) problems.push("The provider sent no canonical operation, so the hash cannot be checked. Do not approve from here.");
  else {
    hashMatches = (await sha256Hex(d.op_canonical)) === d.request_hash.toLowerCase();
    if (!hashMatches) problems.push("The hash you would sign is not the hash of the operation shown. Do not approve.");
    try {
      op = JSON.parse(d.op_canonical);
    } catch {
      problems.push("The operation is not readable.");
    }
  }
  if (!d.wallet_pubkey) problems.push("The approval has no wallet key to bind the vote to.");
  if (d.status !== "pending") problems.push(`This approval is ${d.status}.`);
  else if (Date.parse(d.expires_at) <= nowMs) problems.push("This approval has expired.");

  let matchesNorr: boolean | null = null;
  if (intended && op) {
    const values = leaves(op).map((s) => s.toLowerCase());
    const has = (x: string) => values.some((v) => v === x.toLowerCase() || v.endsWith(`:${x.toLowerCase()}`) || x.toLowerCase().endsWith(`:${v}`));
    const missing = [
      has(intended.tokenIn) ? null : "the token sent",
      has(intended.amountIn) ? null : "the amount",
      has(intended.tokenOut) ? null : "the token received",
    ].filter(Boolean);
    matchesNorr = missing.length === 0;
    if (!matchesNorr) problems.push(`The operation does not match what Norr asked for (${missing.join(", ")} differs). Do not approve.`);
  }
  return { hashMatches, matchesNorr, problems, op };
}

export const canApprove = (c: ApprovalCheck, detail: ApprovalDetail): boolean => c.hashMatches && c.matchesNorr === true && detail.status === "pending" && Boolean(detail.wallet_pubkey) && c.problems.length === 0;

export async function fetchApproval(base: string, approvalId: string, f: typeof fetch = fetch): Promise<ApprovalDetail> {
  const r = await f(`${base}/wallet/v1/approval/${encodeURIComponent(approvalId)}`);
  if (!r.ok) throw new Error(`The custody provider answered ${r.status} for this approval.`);
  return (await r.json()) as ApprovalDetail;
}

/** Send the owner's signed vote straight to the provider. */
export async function sendVote(base: string, kind: VoteKind, approvalId: string, signed: { signature: string; publicKey: string; accountId: string }, nonceB64: string, f: typeof fetch = fetch): Promise<{ status: string; approved?: number; required?: number }> {
  const r = await f(`${base}/wallet/v1/${kind}/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signature: signed.signature, public_key: signed.publicKey, account_id: signed.accountId, nonce: nonceB64 }),
  });
  const body = (await r.json().catch(() => ({}))) as { status?: string; message?: string; error?: string; approved?: number; required?: number };
  if (!r.ok) throw new Error(body.message ?? body.error ?? `The custody provider answered ${r.status}.`);
  return { status: body.status ?? "unknown", approved: body.approved, required: body.required };
}
