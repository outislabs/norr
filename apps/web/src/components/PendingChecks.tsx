import { useEffect, useState } from "react";
import type { PendingItem, PendingList } from "../lib/api";
import { canApprove, checkApproval, fetchApproval, resolveApprovalsBase, sendVote, voteMessage, type ApprovalCheck, type ApprovalDetail, type Intended, type VoteKind } from "../lib/approvals";
import { amount, shortId } from "../lib/format";
import { signVote } from "../lib/signin";

const OUTLAYER_APPROVALS = "https://app.outlayer.ai/wallet/approvals";

export interface ApprovalsProps {
  list: PendingList | null;
  apiBase: string;
  owner: string;
  /** Re-read the list after a vote. */
  onChanged?: () => void;
  /** Injected in tests. */
  sign?: typeof signVote;
  fetchImpl?: typeof fetch;
}

/** One approval at the custody provider: fetched, hashed and compared in this browser, then signed and sent by the owner. */
function ApprovalCard({ approvalId, item, base, recipient, owner, onChanged, sign = signVote, fetchImpl = fetch }: { approvalId: string; item: PendingItem | null; base: string; recipient: string; owner: string; onChanged?: () => void; sign?: typeof signVote; fetchImpl?: typeof fetch }) {
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [check, setCheck] = useState<ApprovalCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<VoteKind | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchApproval(base, approvalId, fetchImpl)
      .then(async (d) => {
        const intended: Intended | null = item?.intended ?? null;
        const c = await checkApproval(d, intended);
        if (live) (setDetail(d), setCheck(c));
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not read this approval from the custody provider."));
    return () => {
      live = false;
    };
  }, [approvalId, base, item, fetchImpl]);

  async function vote(kind: VoteKind) {
    if (!detail?.wallet_pubkey) return;
    setBusy(kind);
    setError(null);
    try {
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const nonceB64 = btoa(String.fromCharCode(...nonce));
      const signed = await sign(voteMessage(kind, approvalId, detail.wallet_pubkey, detail.request_hash), recipient, nonce, owner);
      const r = await sendVote(base, kind, approvalId, signed, nonceB64, fetchImpl);
      setDone(kind === "approve" ? (r.status === "approved" ? "Approved. The custody provider runs the swap now; the activity list settles it within a minute." : `Approval recorded (${r.approved ?? "?"} of ${r.required ?? "?"}).`) : "Rejected. Nothing moved.");
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The vote was not sent.");
    } finally {
      setBusy(null);
    }
  }

  const approvable = detail && check ? canApprove(check, detail) : false;
  return (
    <div className="mt-4 flex flex-col gap-3" data-testid={`approval-${approvalId}`}>
      {!detail && !error && <p className="text-sm text-mute">Reading the approval from the custody provider…</p>}
      {detail && check && (
        <>
          <div>
            <p className="eyebrow mb-2">The operation you would sign (from the custody provider)</p>
            <pre className="mono overflow-x-auto rounded-xl border border-line bg-raised p-3 text-[12px] leading-relaxed">{JSON.stringify(check.op, null, 2)}</pre>
          </div>
          <ul className="flex flex-col gap-1 text-sm">
            <li>{check.hashMatches ? "✓" : "✕"} Hash checked in this browser: sha256 of the operation above {check.hashMatches ? "equals" : "does NOT equal"} the hash you sign (<span className="mono">{shortId(detail.request_hash, 10, 6)}</span>).</li>
            {check.matchesNorr !== null && <li>{check.matchesNorr ? "✓" : "✕"} {check.matchesNorr ? "It names the tokens and amount Norr asked for." : "It does not match what Norr asked for."}</li>}
          </ul>
          {check.problems.length > 0 && (
            <ul role="alert" className="flex flex-col gap-1 border-l border-line-strong pl-3 text-sm text-fg">
              {check.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {done ? (
            <p role="status" className="text-sm text-fg">{done}</p>
          ) : (
            detail.status === "pending" && (
              <div className="flex flex-wrap gap-2">
                {item && (
                  <button type="button" className="btn btn-solid" disabled={!approvable || busy !== null} onClick={() => void vote("approve")}>
                    {busy === "approve" ? "Confirm in your wallet…" : "Approve"}
                  </button>
                )}
                <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void vote("reject")}>
                  {busy === "reject" ? "Confirm in your wallet…" : "Reject"}
                </button>
              </div>
            )
          )}
          <p className="text-xs text-dim">Your wallet signs one message that approves only this operation (it names its hash). Norr does not see or forward the signature: this browser sends it to the custody provider.</p>
        </>
      )}
      {error && <p role="alert" className="border-l border-line-strong pl-3 text-sm text-fg">{error}</p>}
    </div>
  );
}

/** What Norr asked the custody provider for, and the approval to sign in place, so the owner never has to leave the dashboard. */
export function PendingChecks({ items, list, apiBase = "", owner = "", onChanged, sign, fetchImpl }: { items: PendingItem[] } & Partial<ApprovalsProps>) {
  const base = list?.approvalsApi ? resolveApprovalsBase(list.approvalsApi, apiBase) : null;
  const recipient = list?.voteRecipient ?? "outlayer.near";
  const unknown = list?.unknown ?? [];
  if (items.length === 0 && unknown.length === 0) {
    return (
      <div>
        <p className="text-mute">Nothing is waiting for your approval.</p>
        <p className="mt-2 text-sm text-mute">When the agent places a swap, your custody provider holds it until you approve. It shows up here, with Approve and Reject, the moment Norr sends it.</p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-10">
      {items.map((p) => (
        <li key={p.requestId} className="border-l border-line-strong pl-4">
          {p.kind === "withdraw" ? (
            <p className="text-fg">
              You asked to withdraw <b className="mono font-medium">{amount(p.sends.amount)} {p.sends.symbol}</b> from the vault to your account <b className="mono font-medium">{p.recipient}</b>. Withdrawals are private: they never name your vault.
            </p>
          ) : p.kind === "shield" ? (
            <p className="text-fg">
              You asked to move <b className="mono font-medium">{amount(p.sends.amount)} {p.sends.symbol}</b> from the vault's public balance into its confidential balance.
            </p>
          ) : (
            <p className="text-fg">
              Norr asked to send <b className="mono font-medium">{amount(p.sends.amount)} {p.sends.symbol}</b> and receive at least{" "}
              <b className="mono font-medium">{amount(p.receivesAtLeast.amount)} {p.receivesAtLeast.symbol}</b>
              {p.venue === "confidential" ? ", confidentially" : ", publicly"}.
            </p>
          )}
          <p className="mt-1 text-sm text-mute">{p.kind === "withdraw" ? `Paid to your own account, ${p.recipient}: the only destination this vault's custody policy allows.` : `Paid to the vault's own account (${shortId(p.recipient, 10, 6)}).`}</p>
          {p.approvalId && base ? (
            <ApprovalCard approvalId={p.approvalId} item={p} base={base} recipient={recipient} owner={owner} onChanged={onChanged} sign={sign} fetchImpl={fetchImpl} />
          ) : (
            <p className="mt-3 text-sm text-mute">
              {list?.approvalsListed === false ? "The custody provider's approvals could not be read right now." : "The custody provider has not listed an approval for this request yet."} You can also approve it on{" "}
              <a className="text-fg underline decoration-line-strong underline-offset-4" href={OUTLAYER_APPROVALS} target="_blank" rel="noreferrer">
                its approval screen
              </a>
              .
            </p>
          )}
        </li>
      ))}
      {unknown.map((u) => (
        <li key={u.approvalId} className="border-l border-fg pl-4">
          <p className="text-fg">Norr did not ask for this {u.type} operation.</p>
          <p className="mt-1 text-sm text-mute">Someone or something else asked your custody provider for it. Reject it unless you started it yourself.</p>
          {base && <ApprovalCard approvalId={u.approvalId} item={null} base={base} recipient={recipient} owner={owner} onChanged={onChanged} sign={sign} fetchImpl={fetchImpl} />}
        </li>
      ))}
    </ul>
  );
}
