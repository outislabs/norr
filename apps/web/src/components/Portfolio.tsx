import type { Portfolio as P } from "../lib/api";
import { amount, usd } from "../lib/format";
import { Link } from "./Link";

interface Slice {
  label: string;
  value: number;
  className: string;
}

/** A stacked bar with a legend. Colour is never the only signal: each slice is named with its value. */
export function SplitBar({ title, slices }: { title: string; slices: Slice[] }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return null;
  return (
    <div>
      <p className="text-sm text-mute">{title}</p>
      <div className="mt-2 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-line" role="img" aria-label={slices.map((s) => `${s.label} ${usd(s.value)}`).join(", ")}>
        {slices.filter((s) => s.value > 0).map((s) => (
          <div key={s.label} className={s.className} style={{ width: `${(s.value / total) * 100}%` }} />
        ))}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-5 text-sm">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${s.className}`} />
            <span className="text-mute">{s.label}</span> <span className="mono">{usd(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Portfolio({ portfolio, fundHref, reason }: { portfolio: P | null; fundHref?: string; reason?: string }) {
  if (!portfolio)
    return (
      <div className="text-mute">
        <p>Balances are not available right now.</p>
        {/* The real reason, when the service gave one (a custody limit, an outage...); the money itself is untouched. */}
        <p className="mt-1">{reason ?? "Try again in a minute."}</p>
      </div>
    );
  if (portfolio.holdings.length === 0) {
    return (
      <div className="border-l border-line-strong pl-4">
        <p className="font-display text-xl">Nothing in the vault yet</p>
        <p className="mt-1 text-mute">The agent can only trade what the vault holds. Send a small amount of USDC from any chain to get started.</p>
        {fundHref && <Link href={fundHref} className="btn mt-3">Fund the vault</Link>}
      </div>
    );
  }
  const confidential = portfolio.holdings.filter((h) => h.layer === "confidential").reduce((a, h) => a + h.valueUsd, 0);
  const pub = portfolio.holdings.filter((h) => h.layer !== "confidential").reduce((a, h) => a + h.valueUsd, 0);
  return (
    <div>
      <p className="font-display text-5xl tabular-nums tracking-[-0.04em]">{usd(portfolio.totalUsd)}</p>
      <div className="mt-4 flex flex-col gap-4">
        <SplitBar title="By kind" slices={[{ label: "Crypto", value: portfolio.byClass.crypto, className: "bg-fg" }, { label: "Tokenized stocks", value: portfolio.byClass.equity, className: "bg-chart-2" }]} />
        <SplitBar title="By layer" slices={[{ label: "Confidential", value: confidential, className: "bg-fg" }, { label: "Public", value: pub, className: "bg-chart-2" }]} />
      </div>
      <div className="-mx-4 mt-5 overflow-x-auto px-4">
        <table className="w-full min-w-[22rem] text-left text-[15px]">
          <caption className="sr-only">Holdings</caption>
          <thead className="text-sm text-mute">
            <tr>
              <th className="py-2 pr-3 font-normal">Asset</th>
              <th className="py-2 pr-3 text-right font-normal">Amount</th>
              <th className="py-2 pr-3 text-right font-normal">Value</th>
              <th className="py-2 font-normal">Where</th>
            </tr>
          </thead>
          <tbody>
            {portfolio.holdings.map((h) => (
              <tr key={`${h.symbol}-${h.layer}`} className="border-t border-line">
                <td className="py-2 pr-3">{h.symbol}</td>
                <td className="mono py-2 pr-3 text-right">{amount(h.amount, 6)}</td>
                <td className="mono py-2 pr-3 text-right">{usd(h.valueUsd)}</td>
                <td className={`py-2 text-sm ${h.layer === "confidential" ? "text-fg" : "text-mute"}`}>{h.layer === "confidential" ? "Confidential" : h.layer === "public" ? "Public" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
