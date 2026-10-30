import type { Portfolio as P } from "../lib/api";
import { amount, usd } from "../lib/format";

export function Portfolio({ portfolio }: { portfolio: P | null }) {
  if (!portfolio) return <p className="text-mist">Balances are not available right now.</p>;
  if (portfolio.holdings.length === 0) return <p className="text-mist">The vault is empty. Fund it to let the agent trade.</p>;
  return (
    <div>
      <p className="font-display text-4xl">{usd(portfolio.totalUsd)}</p>
      <p className="text-sm text-mist">
        {usd(portfolio.byClass.crypto)} in crypto · {usd(portfolio.byClass.equity)} in tokenized stocks
      </p>
      <table className="mt-4 w-full text-left text-[15px]">
        <caption className="sr-only">Holdings</caption>
        <thead className="text-sm text-mist">
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
              <td className={`py-2 text-sm ${h.layer === "confidential" ? "text-verdigris" : "text-mist"}`}>{h.layer === "confidential" ? "Confidential" : h.layer === "public" ? "Public" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
