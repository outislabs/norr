import type { VaultPnl } from "../lib/api";
import { amount, usd } from "../lib/format";

/** A signed dollar amount: "+$12.30" or "−$4.10". Colour is never the only signal (the dashboard has none). */
export const signedUsd = (n: number): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${usd(Math.abs(n))}`;

/**
 * Profit and loss since the vault's first trade: totals, then one row per asset. Realized from sells at average cost;
 * unrealized is what Norr's buys still hold, at today's listed price. Computed by the service from the vault's ledger.
 */
export function PnlPanel({ pnl }: { pnl: VaultPnl | null }) {
  if (!pnl) return <p className="text-sm text-mute">Profit and loss is not available right now.</p>;
  if (pnl.assets.length === 0) return <p className="text-sm text-mute">No trades yet. Profit and loss appears after the agent&apos;s first trade.</p>;
  const t = pnl.totals;
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-3 gap-4">
        {[
          ["Total", t.totalUsd],
          ["Realized", t.realizedUsd],
          ["Unrealized", t.unrealizedUsd],
        ].map(([label, v]) => (
          <div key={label as string} className="border-t border-line pt-3">
            <dt className="text-sm text-mute">{label}</dt>
            <dd className={`font-display mt-1 tabular-nums ${label === "Total" ? "text-3xl" : "text-xl"}`}>{signedUsd(v as number)}</dd>
          </div>
        ))}
      </dl>
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Profit and loss by asset</caption>
          <thead className="text-xs text-mute">
            <tr>
              <th className="py-2 pr-3 font-normal">Asset</th>
              <th className="py-2 pr-3 text-right font-normal">Held</th>
              <th className="hidden py-2 pr-3 text-right font-normal sm:table-cell">Avg cost</th>
              <th className="hidden py-2 pr-3 text-right font-normal sm:table-cell">Price</th>
              <th className="py-2 pr-3 text-right font-normal">Unrealized</th>
              <th className="py-2 text-right font-normal">Realized</th>
            </tr>
          </thead>
          <tbody>
            {pnl.assets.map((a) => (
              <tr key={a.asset} className="border-t border-line">
                <td className="py-2 pr-3">{a.asset}</td>
                <td className="mono py-2 pr-3 text-right">{a.qtyHeld ? amount(a.qtyHeld, 6) : "0"}</td>
                <td className="mono hidden py-2 pr-3 text-right sm:table-cell">{a.avgCostUsd === null ? "–" : usd(a.avgCostUsd)}</td>
                <td className="mono hidden py-2 pr-3 text-right sm:table-cell">{a.priceUsd === null ? "–" : usd(a.priceUsd)}</td>
                <td className="mono py-2 pr-3 text-right">{a.unrealizedUsd === null ? "no price" : signedUsd(a.unrealizedUsd)}</td>
                <td className="mono py-2 text-right">{signedUsd(a.realizedUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-dim">
        Since {pnl.since ? new Date(pnl.since).toISOString().slice(0, 10) : "the first trade"}. {pnl.scope}
        {pnl.unpriced.length ? ` No current price for ${pnl.unpriced.join(", ")}, so it is left out of unrealized.` : ""}
      </p>
    </div>
  );
}
