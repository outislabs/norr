import { useEffect, useState } from "react";
import type { Api, DirectDeposit } from "../lib/api";
import { vaultHref } from "../lib/route";
import { sendDirectDeposit } from "../lib/signin";
import { CopyBlock } from "./CopyBlock";

/**
 * Paying the vault directly on NEAR, offered only when 1Click cannot quote. The owner's wallet calls ft_transfer_call on
 * the token, crediting the vault's own NEAR Intents account. It lands in the public layer, so it is visible on chain
 * until the owner moves it into the confidential layer (PublicBalance, below).
 */
export function DirectDepositPanel({ api, deposit, send = sendDirectDeposit, onSent }: { api: Api; deposit: DirectDeposit; send?: typeof sendDirectDeposit; onSent?: () => void }) {
  const [state, setState] = useState<"idle" | "waiting" | "sent">("idle");
  const [from, setFrom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manual = JSON.stringify({ contract: deposit.contractId, method: deposit.methodName, args: deposit.args, gas: deposit.gas, deposit_yocto: deposit.deposit }, null, 2);

  return (
    <section aria-labelledby="direct-deposit" className="flex flex-col gap-4 rounded-2xl border border-line p-5" data-testid="direct-deposit">
      <div>
        <h3 id="direct-deposit" className="font-display text-xl">Deposit directly on NEAR</h3>
        <p className="mt-1 text-sm text-mute">
          Send <b className="mono font-medium text-fg">{deposit.amountUsdc} USDC</b> from your NEAR wallet straight to this vault's account on NEAR Intents (<span className="mono">{deposit.recipient.slice(0, 10)}…</span>). The destination is set by Norr: it is always this vault.
        </p>
      </div>
      <p className="border-l border-line-strong pl-3 text-sm text-fg">{deposit.note}</p>
      {state === "sent" ? (
        <p role="status" className="text-sm text-fg">
          Sent{from ? ` from ${from}` : ""}. It shows below as the vault's public balance within a few seconds; then move it into the confidential layer.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-solid"
            disabled={state === "waiting"}
            onClick={async () => {
              setError(null);
              setState("waiting");
              try {
                setFrom(await send(api, deposit));
                setState("sent");
                onSent?.();
              } catch (e) {
                setState("idle");
                setError(e instanceof Error ? e.message : "The wallet did not send.");
              }
            }}
          >
            {state === "waiting" ? "Confirm in your wallet…" : "Send with my NEAR wallet"}
          </button>
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm text-mute">Send from another wallet (the exact call)</summary>
        <p className="mt-2 text-sm text-mute">Call <span className="mono">ft_transfer_call</span> on the USDC contract with these arguments, 1 yoctoNEAR attached and 100 Tgas. Any NEAR account can send it.</p>
        <div className="mt-2">
          <CopyBlock text={manual} label="Direct deposit call" />
        </div>
      </details>
      {error && <p role="alert" className="text-sm text-fg">{error}</p>}
    </section>
  );
}

/** The vault's public USDC (after a direct deposit) and the owner's one-tap move into the confidential layer. */
export function PublicBalance({ api, vaultId, version = 0, pollMs = 5000 }: { api: Api; vaultId: string; version?: number; pollMs?: number }) {
  const [usdc, setUsdc] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const v = await api.vault(vaultId);
        const pub = v.portfolio?.holdings.filter((h) => h.layer === "public" && h.symbol === "USDC").reduce((s, h) => s + h.amount, 0) ?? 0;
        if (live) setUsdc(pub);
      } catch {
        /* keep the last reading */
      }
    };
    void read();
    const t = setInterval(() => void read(), pollMs);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [api, vaultId, version, pollMs]);

  if (!usdc && !done) return null;
  return (
    <section aria-labelledby="public-balance" className="flex flex-col gap-3 rounded-2xl border border-line p-5" data-testid="public-balance">
      <h3 id="public-balance" className="font-display text-xl">Public balance</h3>
      {done ? (
        <p role="status" className="text-sm text-fg">
          {done}{" "}
          <a className="underline decoration-line-strong underline-offset-4" href={vaultHref(vaultId, "approvals")}>
            Open Approvals
          </a>
        </p>
      ) : (
        <>
          <p className="text-sm text-mute">
            <b className="mono font-medium text-fg">{usdc} USDC</b> sits in the vault's public balance: visible on chain, and not used by trades (this vault trades confidentially). Move it into the confidential layer; the move stays inside the vault and waits for your approval.
          </p>
          <div>
            <button
              type="button"
              className="btn btn-solid"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const r = await api.shield(vaultId);
                  setDone(r.status === "done" ? `Moved ${r.amountUsdc} USDC into the confidential layer.` : (r.message ?? "Waiting for your approval."));
                } catch (e) {
                  setError(e instanceof Error ? e.message : "The move was not started.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Asking the custody provider…" : "Move into the confidential layer"}
            </button>
          </div>
        </>
      )}
      {error && <p role="alert" className="text-sm text-fg">{error}</p>}
    </section>
  );
}
