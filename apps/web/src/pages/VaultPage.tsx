import { useState } from "react";
import type { Policy } from "@norr/shared";
import { ActivityList } from "../components/ActivityList";
import { AgentAccess } from "../components/AgentAccess";
import { PendingChecks } from "../components/PendingChecks";
import { PolicyForm } from "../components/PolicyForm";
import { Portfolio } from "../components/Portfolio";
import type { Api } from "../lib/api";
import { ago, shortId, usd } from "../lib/format";
import { vaultHref, type Route } from "../lib/route";
import { useAsync } from "../lib/useAsync";

type Tab = Extract<Route, { name: "vault" }>["tab"];
const TABS: [Tab, string][] = [["overview", "Overview"], ["rules", "Rules"], ["activity", "Activity"], ["approvals", "Approvals"]];

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 100;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-mist">{label}</span>
        <span className="mono">{usd(value)} of {usd(max, 0)}</span>
      </div>
      <div className="mt-1 h-1.5 bg-line" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <div className={`h-full ${pct >= 90 ? "bg-rust" : "bg-brass"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function VaultPage({ api, id, tab, onChanged }: { api: Api; id: string; tab: Tab; onChanged: () => void }) {
  const vault = useAsync(() => api.vault(id), `vault-${id}`);
  const activity = useAsync(() => (tab === "activity" ? api.activity(id) : Promise.resolve(null)), `act-${id}-${tab}`);
  const pending = useAsync(() => api.pending(id), `pend-${id}-${tab}`);
  const [toggling, setToggling] = useState(false);

  if (vault.loading && !vault.data) return <p className="text-mist">Loading…</p>;
  if (vault.error || !vault.data) return <p role="alert" className="text-rust">{vault.error ?? "This vault could not be found."}</p>;
  const v = vault.data;

  const save = async (p: Policy) => {
    await api.setPolicy(id, p);
    vault.reload();
    onChanged();
  };

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-3xl">{v.id}</h1>
        <div className="flex items-center gap-3">
          <span className={v.paused ? "text-rust" : "text-verdigris"}>{v.paused ? "Paused" : "Active"}</span>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={toggling}
            onClick={async () => {
              setToggling(true);
              try {
                await (v.paused ? api.resume(id) : api.pause(id));
                vault.reload();
                onChanged();
              } finally {
                setToggling(false);
              }
            }}
          >
            {v.paused ? "Resume" : "Pause this vault"}
          </button>
        </div>
      </div>
      <p className="mono mt-1 text-sm text-mist" title={v.walletAccount}>Custody wallet {shortId(v.walletAccount, 12, 6)}</p>

      <nav className="mt-6 flex gap-6 border-b border-line" aria-label="Vault sections">
        {TABS.map(([t, label]) => (
          <a key={t} href={vaultHref(id, t)} aria-current={t === tab ? "page" : undefined} className={`pb-2 ${t === tab ? "border-b border-brass text-ivory" : "text-mist hover:text-ivory"}`}>
            {label}
            {t === "approvals" && pending.data && pending.data.pending.length > 0 ? ` (${pending.data.pending.length})` : ""}
          </a>
        ))}
      </nav>

      <div className="mt-8">
        {tab === "overview" && (
          <div className="flex flex-col gap-10">
            <Portfolio portfolio={v.portfolio} />
            <div className="flex flex-col gap-4">
              <h2 className="font-display text-xl">Today</h2>
              <Meter label="Spent on buys" value={v.state.spentTodayUsd} max={v.policy.dailySpendCapUsd} />
              <Meter label="Realized loss" value={v.state.realizedLossTodayUsd} max={v.policy.dailyLossCapUsd} />
              <p className="text-sm text-mist">{v.state.lastTradeAt ? `Last trade ${ago(v.state.lastTradeAt)}.` : "No trades yet."}</p>
            </div>
            <div>
              <h2 className="font-display text-xl">Your agent</h2>
              <div className="mt-2">
                <AgentAccess api={api} vaultId={id} />
              </div>
            </div>
          </div>
        )}
        {tab === "rules" && <PolicyForm key={JSON.stringify(v.policy)} policy={v.policy} onSave={save} />}
        {tab === "activity" && (activity.error ? <p role="alert" className="text-rust">{activity.error}</p> : activity.data ? <ActivityList items={activity.data.activity} /> : <p className="text-mist">Loading…</p>)}
        {tab === "approvals" && (
          <div>
            <h2 className="font-display text-xl">Check before you sign</h2>
            <p className="mb-5 mt-1 text-sm text-mist">Your custody provider asks you to approve each swap. Compare what is on its screen with what Norr actually asked for.</p>
            {pending.error ? <p role="alert" className="text-rust">{pending.error}</p> : <PendingChecks items={pending.data?.pending ?? []} />}
          </div>
        )}
      </div>
    </section>
  );
}
