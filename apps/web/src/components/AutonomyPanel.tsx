import { useState } from "react";
import type { Api, PreparedPolicy } from "../lib/api";
import { sendPolicyStore } from "../lib/signin";

const near = (yocto: string) => (Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4);

/**
 * Autonomous mode, shown as what it is: ON or OFF, in words, with the control to switch it by one wallet signature.
 * The mode lives in the custody policy the owner controls on chain, so a switch is an update the owner's wallet signs;
 * Norr then checks that the custody provider holds exactly that change before reporting it done.
 */
export function AutonomyPanel({ api, vaultId, autonomous, account, onChanged, send = sendPolicyStore, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }: { api: Api; vaultId: string; autonomous: boolean; account: string; onChanged?: () => void; send?: typeof sendPolicyStore; sleep?: (ms: number) => Promise<void> }) {
  const target = !autonomous;
  const [prepared, setPrepared] = useState<(PreparedPolicy & { autonomous: boolean }) | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState<null | "prepare" | "sign" | "check">(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);

  async function prepare() {
    setBusy("prepare");
    setError(null);
    setProblems([]);
    try {
      setPrepared(await api.setCustodyMode(vaultId, target));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change was not prepared.");
    } finally {
      setBusy(null);
    }
  }

  async function confirm(retries: number) {
    setBusy("check");
    try {
      for (let i = 0; i <= retries; i++) {
        const r = await api.confirmCustodyMode(vaultId);
        if (r.status === "applied") {
          setDone(r.autonomous ? "Autonomous mode is now ON." : "Autonomous mode is now OFF. Every swap waits for your approval.");
          setPrepared(null);
          onChanged?.();
          return;
        }
        setProblems(r.problems);
        if (i === retries) return;
        await sleep(3000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check the change right now.");
    } finally {
      setBusy(null);
    }
  }

  async function sign() {
    if (!prepared) return;
    setBusy("sign");
    setError(null);
    try {
      await send(api, prepared.call, account);
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : "The transaction was not sent.");
      return;
    }
    await confirm(5);
  }

  return (
    <section aria-labelledby="autonomy" className="flex flex-col gap-4" data-testid="autonomy-panel">
      <div>
        <h3 id="autonomy" className="font-display text-xl">Autonomous mode</h3>
        <p className="mt-1 text-fg">
          Currently <b className="font-medium" data-testid="autonomy-state">{autonomous ? "ON" : "OFF"}</b>.
        </p>
        <p className="mt-1 text-sm text-mute">
          {autonomous
            ? "Your agent's swaps run without your signature, within the largest trade, the daily cap and the operations-per-hour limit. Money can only be sent to your own account."
            : "Every swap waits for your approval in the Approvals tab. This is the default."}
        </p>
      </div>
      {done && <p role="status" className="text-sm text-fg">{done}</p>}
      {!prepared && (
        <div className="flex flex-col gap-3">
          {target && (
            <label htmlFor="autonomy-understood" className="flex cursor-pointer gap-2 border-l border-line-strong pl-3 text-sm">
              <input id="autonomy-understood" type="checkbox" className="mt-0.5 accent-white" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
              <span>I understand my agent's swaps will run without my approval, up to the limits.</span>
            </label>
          )}
          <div>
            <button type="button" className="btn btn-quiet" disabled={busy !== null || (target && !understood)} onClick={() => void prepare()}>
              {busy === "prepare" ? "Preparing…" : target ? "Turn autonomous mode on" : "Turn autonomous mode off"}
            </button>
          </div>
        </div>
      )}
      {prepared && (
        <div className="flex flex-col gap-3" data-testid="mode-change">
          <ul className="flex flex-col border-t border-line">
            {prepared.summary.map((s) => (
              <li key={s} className="border-b border-line py-2 text-sm">{s}</li>
            ))}
          </ul>
          <p className="text-sm text-mute">
            Your wallet signs one transaction to <span className="mono">{prepared.call.contractId}</span> that updates your vault's custody policy, attaching <span className="mono">{near(prepared.call.deposit)} NEAR</span> (unused storage is refunded to you).
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-solid" disabled={busy !== null} onClick={() => void sign()}>
              {busy === "sign" ? "Confirm in your wallet…" : busy === "check" ? "Checking the chain…" : "Sign with your wallet"}
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => void confirm(0)}>
              I already signed: check
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => (setPrepared(null), setProblems([]))}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {problems.length > 0 && (
        <ul role="alert" className="flex flex-col gap-1 border-l border-line-strong pl-3 text-sm text-fg">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="border-l border-line-strong pl-3 text-sm text-fg">{error}</p>}
    </section>
  );
}
