import { useEffect, useState } from "react";
import type { Api, Holding, WithdrawPlan } from "../lib/api";
import { vaultHref } from "../lib/route";

/**
 * Owner-only withdrawal from the vault's confidential balance to the owner's own account. The destination is the signed-in
 * owner, shown and never editable here (the server sets it too, and the vault's custody policy whitelists only it).
 * Two steps: a dry run that moves nothing and states what becomes public, then the request, which waits for the owner's
 * approval in the Approvals tab, where the browser checks the provider's hash and operation.
 */
export function WithdrawPanel({ api, vaultId, owner, holdings, initialAsset, onRequested }: { api: Api; vaultId: string; owner: string; holdings: Holding[]; initialAsset?: string; onRequested?: () => void }) {
  // Opened from "Withdraw to my wallet" on a position too small to sell: that token, all of it.
  const preset = initialAsset !== undefined && holdings.some((h) => h.assetId === initialAsset) ? initialAsset : undefined;
  const [assetId, setAssetId] = useState(preset ?? holdings[0]?.assetId ?? "");
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(preset !== undefined);
  const [plan, setPlan] = useState<WithdrawPlan | null>(null);
  const [busy, setBusy] = useState<"check" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!assetId && holdings[0]?.assetId) setAssetId(holdings[0].assetId);
  }, [holdings, assetId]);

  const held = holdings.find((h) => h.assetId === assetId);
  const body = (dryRun: boolean) => ({ asset: assetId, dryRun, ...(max ? { max: true } : { amount: amount.trim() }) });
  const reset = () => (setPlan(null), setDone(null), setError(null));

  async function run(dryRun: boolean) {
    setBusy(dryRun ? "check" : "send");
    setError(null);
    try {
      const r = await api.withdraw(vaultId, body(dryRun));
      if ("dryRun" in r) setPlan(r.plan);
      else {
        setPlan(null);
        setDone(r.status === "done" ? `Withdrawn: ${r.plan.amount} ${r.plan.asset} to ${r.plan.destination}.` : r.message);
        onRequested?.();
      }
    } catch (e) {
      setPlan(null);
      setError(e instanceof Error ? e.message : "The withdrawal was not started.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="withdraw" className="flex flex-col gap-5" data-testid="withdraw-panel">
      <div>
        <h2 id="withdraw" className="font-display text-xl">Withdraw to your account</h2>
        <p className="mt-1 text-sm text-mute">Takes money out of the vault's confidential balance. Only you can do this: the agent has no tool for it and cannot choose where money goes.</p>
      </div>
      {holdings.length === 0 ? (
        <p className="text-mute">The vault holds nothing in its confidential balance yet. Fund it first; anything in its public balance has to be moved into the confidential layer before it can be withdrawn.</p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <p className="eyebrow">Destination (fixed)</p>
            <p className="mono text-fg" data-testid="withdraw-destination">{owner}</p>
            <p className="text-xs text-dim">The one account this vault's custody policy allows. It is not editable.</p>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-mute">Asset</span>
            <select className="field" value={assetId} onChange={(e) => (setAssetId(e.target.value), setMax(false), setAmount(""), reset())}>
              {holdings.map((h) => (
                <option key={h.assetId} value={h.assetId}>{h.symbol} (confidential balance {h.amount})</option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="withdraw-amount" className="text-mute">Amount{held ? ` of ${held.symbol}` : ""}</label>
            <div className="flex gap-2">
              <input id="withdraw-amount" className="field mono flex-1" inputMode="decimal" placeholder="1.00" value={max ? "Everything the vault holds" : amount} disabled={max} onChange={(e) => (setAmount(e.target.value), reset())} />
              <button type="button" className="btn btn-quiet" aria-pressed={max} onClick={() => (setMax(!max), reset())}>{max ? "Enter an amount" : "Max"}</button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-quiet" disabled={busy !== null || !assetId || (!max && amount.trim() === "")} onClick={() => void run(true)}>
              {busy === "check" ? "Checking…" : "Check first (moves nothing)"}
            </button>
          </div>
        </>
      )}
      {plan && (
        <div className="flex flex-col gap-3 rounded-2xl border border-line p-5" data-testid="withdraw-plan">
          <p className="text-fg">
            Withdraw <b className="mono font-medium">{plan.amount} {plan.asset}</b> from the confidential balance ({plan.balance} {plan.asset} held) to <b className="mono font-medium">{plan.destination}</b> on NEAR.
          </p>
          <p className="border-l border-line-strong pl-3 text-sm text-fg"><b className="font-medium">What becomes public: </b>{plan.becomesPublic}</p>
          <p className="text-sm text-mute">{plan.approval}</p>
          <div>
            <button type="button" className="btn btn-solid" disabled={busy !== null} onClick={() => void run(false)}>
              {busy === "send" ? "Asking the custody provider…" : "Request this withdrawal"}
            </button>
          </div>
        </div>
      )}
      {done && (
        <p role="status" className="text-sm text-fg">
          {done} <a className="underline decoration-line-strong underline-offset-4" href={vaultHref(vaultId, "approvals")}>Open Approvals</a>
        </p>
      )}
      {error && <p role="alert" className="border-l border-line-strong pl-3 text-sm text-fg">{error}</p>}
    </section>
  );
}
