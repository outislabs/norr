import type { Api } from "../lib/api";
import { usd } from "../lib/format";
import { vaultHref } from "../lib/route";
import { useAsync } from "../lib/useAsync";

export function VaultsPage({ api, account, version }: { api: Api; account: string; version: number }) {
  const { data, error, loading } = useAsync(() => api.vaults(), `vaults-${version}`);
  return (
    <section className="max-w-3xl">
      <h1 className="font-display text-3xl">Your vaults</h1>
      <div className="rule mt-3" />
      {loading && <p className="mt-6 text-mute">Loading…</p>}
      {error && <p role="alert" className="mt-6 text-alert">{error}</p>}
      {data && data.vaults.length === 0 && (
        <div className="mt-6 border-l border-line-strong pl-4">
          <p className="font-display text-xl">No vault is linked to this account</p>
          <p className="mt-1 text-mute">You signed in as <span className="mono">{account}</span>. A vault belongs to the NEAR account that owns it, so check that this is the account the vault was set up for. Signing in with another account shows nothing, by design.</p>
          <a href="#/verify" className="btn btn-quiet mt-3">Check the enclave while you are here</a>
        </div>
      )}
      <ul>
        {data?.vaults.map((v) => (
          <li key={v.id} className="border-b border-line">
            <a href={vaultHref(v.id)} className="-mx-3 block rounded-xl px-3 py-5 hover:bg-raised">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-display text-2xl">{v.id}</span>
                <span className={v.paused ? "text-alert" : "text-ok"}>{v.paused ? "Paused" : "Active"}</span>
              </div>
              <p className="mt-1 text-sm text-mute">
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
