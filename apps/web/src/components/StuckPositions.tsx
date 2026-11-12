import { useState } from "react";
import type { ExitResult, Holding } from "../lib/api";
import { usd } from "../lib/format";

/** Mirrors core's topUpUsd: at least one minimum order, and enough to end a few percent above the minimum after fees. */
export const topUpEstimate = (heldUsd: number, minUsd: number): number => Math.ceil(Math.max(minUsd, (minUsd * 1.03 - heldUsd) / 0.98) * 100 - 1e-6) / 100;

/**
 * Stock positions worth less than the smallest order solvers quote, so they cannot be sold as they are (after a price
 * drop, say). Two ways out: top up and sell all (two ordinary trades, within the vault's rules and approvals), or
 * withdraw the tokens to the owner's own wallet (the existing withdraw flow, with that token chosen).
 */
export function StuckPositions({ holdings, onExit, withdrawHref }: { holdings: Holding[]; onExit: (assetId: string) => Promise<ExitResult>; withdrawHref: (assetId: string) => string }) {
  const stuck = holdings.filter((h) => h.belowMinSell && h.assetId && h.minSellUsd);
  if (stuck.length === 0) return null;
  return (
    <section aria-labelledby="stuck" className="border-l border-line-strong pl-4" data-testid="stuck-positions">
      <h2 id="stuck" className="font-display text-xl">Too small to sell</h2>
      <p className="mt-1 text-sm text-mute">NEAR Intents solvers do not quote stock orders below a minimum, so these positions cannot be sold as they are.</p>
      <ul className="mt-4 flex flex-col gap-6">
        {stuck.map((h) => (
          <StuckRow key={`${h.assetId}-${h.layer}`} h={h} onExit={onExit} withdrawHref={withdrawHref} />
        ))}
      </ul>
    </section>
  );
}

function StuckRow({ h, onExit, withdrawHref }: { h: Holding; onExit: (assetId: string) => Promise<ExitResult>; withdrawHref: (assetId: string) => string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const min = h.minSellUsd!;
  const topUp = topUpEstimate(h.valueUsd, min);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const r = await onExit(h.assetId!);
      setResult({ ok: r.status !== "stopped", text: r.message });
      setConfirming(false);
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : "Nothing was traded." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-3">
      <p>
        <span className="text-fg">{h.symbol}</span> <span className="mono">{usd(h.valueUsd)}</span>
        <span className="text-mute"> is below the minimum sell size of ~{usd(min)}.</span>
      </p>
      {confirming ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-mute">
            Buys about <span className="mono text-fg">{usd(topUp)}</span> of {h.symbol}, then sells the whole position (about <span className="mono text-fg">{usd(h.valueUsd + topUp)}</span>). Both are ordinary trades: your rules apply, and with approvals on you approve each one in Approvals.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn" disabled={busy} onClick={() => void run()}>{busy ? "Working…" : "Confirm top up and sell all"}</button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={() => (setConfirming(true), setResult(null))}>Top up and sell all</button>
          <a className="btn btn-quiet" href={withdrawHref(h.assetId!)}>Withdraw to my wallet</a>
        </div>
      )}
      {result && <p role={result.ok ? "status" : "alert"} className="text-sm text-fg">{result.text}</p>}
    </li>
  );
}
