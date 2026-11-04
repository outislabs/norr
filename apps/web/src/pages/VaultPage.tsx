import { useState } from "react";
import type { Policy } from "@norr/shared";
import { ActivityList } from "../components/ActivityList";
import { ConnectAgent } from "../components/ConnectAgent";
import { Onboarding } from "../components/Onboarding";
import { ValueChart } from "../components/ValueChart";
import { ActivityTab } from "../components/ActivityTab";
import { FundingPanel } from "../components/FundingPanel";
import { PendingChecks } from "../components/PendingChecks";
import { PolicyForm } from "../components/PolicyForm";
import { Portfolio } from "../components/Portfolio";
import { PnlPanel } from "../components/PnlPanel";
import { AssetCheckPanel } from "../components/AssetCheckPanel";
import type { Api } from "../lib/api";
import { ago, shortId, usd } from "../lib/format";
import { getFlag, setFlag } from "../lib/flags";
import { onboardingSteps } from "../lib/onboarding";
import { useEffect } from "react";
import { vaultHref, type Route } from "../lib/route";
import { useAsync } from "../lib/useAsync";

type Tab = Extract<Route, { name: "vault" }>["tab"];
const TABS: [Tab, string][] = [["overview", "Overview"], ["fund", "Fund"], ["connect", "Connect"], ["rules", "Rules"], ["activity", "Activity"], ["approvals", "Approvals"]];

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 100;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-mute">{label}</span>
        <span className="mono">{usd(value)} of {usd(max, 0)}</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <div className={`h-full ${pct >= 90 ? "bg-fg" : "bg-mute"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function VaultPage({ api, account, id, tab, mcpUrl, apiUrl, onChanged }: { api: Api; account: string; id: string; tab: Tab; mcpUrl: string; apiUrl?: string; onChanged: () => void }) {
  const vault = useAsync(() => api.vault(id), `vault-${id}`);
  const activity = useAsync(() => (tab === "activity" ? api.activity(id) : Promise.resolve(null)), `act-${id}-${tab}`);
  const pending = useAsync(() => api.pending(id), `pend-${id}-${tab}`);
  const history = useAsync(() => (tab === "overview" ? api.history(id) : Promise.resolve(null)), `hist-${id}-${tab}`);
  const pnl = useAsync(() => (tab === "overview" ? api.pnl(id) : Promise.resolve(null)), `pnl-${id}-${tab}`);
  const [toggling, setToggling] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (tab === "rules") setFlag(`rules-${id}`);
  }, [tab, id]);

  if (vault.loading && !vault.data) return <p className="text-mute">Loading…</p>;
  if (vault.error || !vault.data) return <p role="alert" className="text-alert">{vault.error ?? "This vault could not be found."}</p>;
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
          <span className={v.paused ? "text-alert" : "text-ok"}>{v.paused ? "Paused" : "Active"}</span>
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
      <p className="mono mt-1 text-sm text-mute" title={v.walletAccount}>Custody wallet {shortId(v.walletAccount, 12, 6)}</p>

      <nav className="-mx-4 mt-6 flex gap-6 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0" aria-label="Vault sections">
        {TABS.map(([t, label]) => (
          <a key={t} href={vaultHref(id, t)} aria-current={t === tab ? "page" : undefined} className={`shrink-0 whitespace-nowrap pb-2 ${t === tab ? "border-b border-accent text-fg" : "text-mute hover:text-fg"}`}>
            {label}
            {t === "approvals" && pending.data && pending.data.pending.length > 0 ? ` (${pending.data.pending.length})` : ""}
          </a>
        ))}
      </nav>

      <div className="mt-8">
        {tab === "overview" && (
          <div className="flex flex-col gap-10">
            <Onboarding
              vaultId={id}
              steps={onboardingSteps({ totalUsd: v.portfolio?.totalUsd ?? null, tokenIssued: getFlag(`token-${id}`), hasActivity: Boolean(v.state.lastTradeAt), rulesReviewed: getFlag(`rules-${id}`) })}
            />
            {/* Wide screens: holdings and history on the left; today's limits and the agent on the right. */}
            <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-16">
            <div className="flex min-w-0 flex-col gap-10">
            <Portfolio portfolio={v.portfolio} fundHref={vaultHref(id, "fund")} />
            <div>
              <h2 className="font-display text-xl">Value over time</h2>
              <div className="mt-3">{history.data ? <ValueChart points={history.data.points} /> : <p className="text-sm text-mute">Loading…</p>}</div>
            </div>
            <div>
              <h2 className="font-display text-xl">Profit and loss</h2>
              <div className="mt-3">{pnl.loading && !pnl.data ? <p className="text-sm text-mute">Loading…</p> : <PnlPanel pnl={pnl.data} />}</div>
            </div>
            </div>
            <aside className="flex flex-col gap-10 lg:border-l lg:border-line lg:pl-10">
            <div className="flex flex-col gap-4">
              <h2 className="font-display text-xl">Today</h2>
              <Meter label="Spent on buys" value={v.state.spentTodayUsd} max={v.policy.dailySpendCapUsd} />
              <Meter label="Realized loss" value={v.state.realizedLossTodayUsd} max={v.policy.dailyLossCapUsd} />
              <p className="text-sm text-mute">{v.state.lastTradeAt ? `Last trade ${ago(v.state.lastTradeAt)}.` : "No trades yet."}</p>
            </div>
            <div>
              <h2 className="font-display text-xl">Your agent</h2>
              <p className="mt-1 text-sm text-mute">It holds one token for this vault and cannot move money out or change your rules.</p>
              <a href={vaultHref(id, "connect")} className="btn btn-quiet mt-3">Connect or rotate the token</a>
            </div>
            </aside>
            </div>
          </div>
        )}
        {tab === "connect" && <div className="max-w-2xl"><ConnectAgent api={api} vaultId={id} mcpUrl={mcpUrl} apiUrl={apiUrl} onIssued={() => tick((n) => n + 1)} /></div>}
        {tab === "fund" && <div className="max-w-2xl"><FundingPanel api={api} vaultId={id} account={account} onArrived={() => vault.reload()} /></div>}
        {tab === "rules" && (
          <div className="flex max-w-2xl flex-col gap-12">
            <PolicyForm key={JSON.stringify(v.policy)} policy={v.policy} onSave={save} />
            <AssetCheckPanel api={api} vaultId={id} />
          </div>
        )}
        {tab === "activity" && (activity.error ? <p role="alert" className="text-alert">{activity.error}</p> : activity.data ? <ActivityTab api={api} account={account} vaultId={id} items={activity.data.activity} reload={activity.reload} /> : <p className="text-mute">Loading…</p>)}
        {tab === "approvals" && (
          <div className="max-w-2xl">
            <h2 className="font-display text-xl">Check before you sign</h2>
            <p className="mb-5 mt-1 text-sm text-mute">Your custody provider asks you to approve each swap. Compare what is on its screen with what Norr actually asked for.</p>
            {pending.error ? <p role="alert" className="text-alert">{pending.error}</p> : <PendingChecks items={pending.data?.pending ?? []} />}
          </div>
        )}
      </div>
    </section>
  );
}
