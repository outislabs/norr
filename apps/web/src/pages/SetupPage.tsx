import { useState } from "react";
import type { Api, PreparedPolicy } from "../lib/api";
import { vaultHref } from "../lib/route";
import { sendPolicyStore } from "../lib/signin";
import { useAsync } from "../lib/useAsync";

const near = (yocto: string) => (Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4);

/**
 * Finishing a new vault: review the custody policy Norr proposes, store it with one transaction from the owner's own
 * wallet (which makes the owner its controller), and activate once Norr has checked the chain and the custody provider.
 */
export function SetupPage({ api, account, id, onChanged, send = sendPolicyStore, navigate = (h) => (window.location.hash = h), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: { api: Api; account: string; id: string; onChanged?: () => void; send?: typeof sendPolicyStore; navigate?: (hash: string) => void; sleep?: (ms: number) => Promise<void> }) {
  const setup = useAsync(() => api.setupVault(id), `setup-${id}`);
  const [autonomous, setAutonomous] = useState(false);
  const [prepared, setPrepared] = useState<PreparedPolicy | null>(null);
  const [busy, setBusy] = useState<null | "prepare" | "sign" | "check">(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [signed, setSigned] = useState(false);

  async function prepare() {
    setBusy("prepare");
    setError(null);
    setProblems([]);
    try {
      setPrepared(await api.prepareCustody(id, autonomous));
      setSigned(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The policy was not prepared.");
    } finally {
      setBusy(null);
    }
  }

  async function activate(retries: number) {
    setBusy("check");
    setError(null);
    try {
      for (let i = 0; i <= retries; i++) {
        const r = await api.activateVault(id);
        if (r.status === "active") {
          onChanged?.();
          navigate(vaultHref(id, "fund"));
          return;
        }
        setProblems(r.problems);
        // Right after signing, the chain may need a few seconds; only "not on chain yet" is worth waiting for.
        if (!r.problems.some((p) => /not on chain yet/.test(p)) || i === retries) return;
        await sleep(3000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check the vault right now.");
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
      setSigned(true);
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : "The transaction was not sent.");
      return;
    }
    await activate(5);
  }

  if (setup.loading) return <p className="text-mute">Loading…</p>;
  if (setup.error || !setup.data) {
    return (
      <section className="max-w-2xl">
        <p className="text-mute">This vault is not waiting for setup. It may be active already.</p>
        <a className="btn btn-quiet mt-3" href={vaultHref(id)}>Open the vault</a>
      </section>
    );
  }
  const v = setup.data;

  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <div>
        <p className="eyebrow">New vault</p>
        <h1 className="font-display mt-1 text-3xl">Sign its custody policy</h1>
        <p className="mt-2 text-mute">
          Your vault's wallet (<span className="mono">{v.walletAccount.slice(0, 10)}…</span>) has no policy yet, so nothing can be funded or traded. Its policy is stored on chain by your own wallet: that makes <span className="mono">{account}</span> its controller, and only you can ever change or freeze it. Norr cannot.
        </p>
      </div>

      {!prepared && (
        <div className="flex flex-col gap-4">
          <label className="flex cursor-pointer gap-3">
            <input type="checkbox" className="mt-1.5 accent-white" checked={autonomous} onChange={(e) => setAutonomous(e.target.checked)} />
            <span>
              <span className="block text-fg">Autonomous mode (off by default)</span>
              <span className="block text-sm text-mute">
                Your agent's swaps run without your signature, within the limits. Withdrawals and transfers also skip approval, but they can still only go to your own account. Leave it off to approve every operation in Norr's Approvals tab.
              </span>
            </span>
          </label>
          <div>
            <button type="button" className="btn btn-solid" disabled={busy !== null} onClick={() => void prepare()}>
              {busy === "prepare" ? "Preparing…" : "Review the policy"}
            </button>
            {v.custody.prepared && (
              <button type="button" className="btn btn-quiet ml-2" disabled={busy !== null} onClick={() => void activate(0)}>
                {busy === "check" ? "Checking…" : "I already signed it: check"}
              </button>
            )}
          </div>
        </div>
      )}

      {prepared && (
        <div className="flex flex-col gap-4" data-testid="prepared-policy">
          <ul className="flex flex-col border-t border-line">
            {prepared.summary.map((s) => (
              <li key={s} className="border-b border-line py-3">{s}</li>
            ))}
          </ul>
          <details>
            <summary className="cursor-pointer text-sm text-mute">The policy as the custody provider will hold it (JSON)</summary>
            <pre className="mono mt-2 max-h-80 overflow-auto rounded-xl border border-line bg-raised p-3 text-[12px] leading-relaxed">{JSON.stringify(prepared.policy, null, 2)}</pre>
          </details>
          <p className="text-sm text-mute">
            Your wallet will ask you to sign one transaction to <span className="mono">{prepared.call.contractId}</span> (<span className="mono">{prepared.call.methodName}</span>), attaching <span className="mono">{near(prepared.call.deposit)} NEAR</span> for storage. The storage is yours: it comes back if the policy is ever removed.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-solid" disabled={busy !== null} onClick={() => void sign()}>
              {busy === "sign" ? "Confirm in your wallet…" : busy === "check" ? "Checking the chain…" : signed ? "Sign again" : "Sign with your wallet"}
            </button>
            {signed && (
              <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => void activate(0)}>
                Check again
              </button>
            )}
            <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => (setPrepared(null), setProblems([]))}>
              Change
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
