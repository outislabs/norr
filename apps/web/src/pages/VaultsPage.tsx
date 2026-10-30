import type { Api } from "../lib/api";
import { usd } from "../lib/format";
import { vaultHref } from "../lib/route";
import { useAsync } from "../lib/useAsync";

export function VaultsPage({ api, account, version }: { api: Api; account: string; version: number }) {
  const { data, error, loading } = useAsync(() => api.vaults(), `vaults-${version}`);
  return (
    <section>
      <h1 className="font-display text-3xl">Your vaults</h1>
      <div className="rule mt-3" />
      {loading && <p className="mt-6 text-mist">Loading…</p>}
      {error && <p role="alert" className="mt-6 text-rust">{error}</p>}
      {data && data.vaults.length === 0 && <p className="mt-6 text-mist">No vaults are linked to {account} yet.</p>}
      <ul>
        {data?.vaults.map((v) => (
          <li key={v.id} className="border-b border-line">
            <a href={vaultHref(v.id)} className="block py-5 hover:bg-vault">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-display text-2xl">{v.id}</span>
                <span className={v.paused ? "text-rust" : "text-verdigris"}>{v.paused ? "Paused" : "Active"}</span>
              </div>
              <p className="mt-1 text-sm text-mist">
                Spent today {usd(v.state.spentTodayUsd)} of {usd(v.policy.dailySpendCapUsd)} ·{" "}
                {v.policy.privacy === "require" ? "confidential only" : v.policy.privacy === "prefer" ? "confidential when possible" : "public only"} · largest trade {usd(v.policy.maxTradeUsd, 0)}
              </p>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
