import type { Api, ActivityItem } from "../lib/api";
import { useReasoning } from "../lib/useReasoning";
import { ActivityList, describe } from "./ActivityList";

/** The activity timeline plus the control that unlocks the agent's sealed reasoning with the owner's wallet. */
export function ActivityTab({ api, account, vaultId, items, reload }: { api: Api; account: string; vaultId: string; items: ActivityItem[]; reload: () => void }) {
  const r = useReasoning(api, account, vaultId, items, reload);
  const sealed = items.some((i) => i.sealedReason);
  const counts = new Map<string, number>();
  for (const it of items) {
    const label = describe(it.decision).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  // Wide screens: the timeline on the left, a summary and the reasoning lock in a side column. Phones: lock first.
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-16">
      <aside className="flex flex-col gap-6 lg:order-2 lg:border-l lg:border-line lg:pl-10">
      {items.length > 0 && (
        <div className="hidden lg:block">
          <p className="eyebrow mb-2">Shown here</p>
          <dl>
            {[...counts].map(([label, n]) => (
              <div key={label} className="flex justify-between border-t border-line py-2.5 text-sm">
                <dt className="text-mute">{label}</dt>
                <dd className="mono">{n}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {sealed && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-raised p-4 lg:flex-col lg:items-start">
          <p className="max-w-lg text-sm text-mute">
            {r.state === "open"
              ? "The agent's reasoning is unlocked in this tab. It is sealed to a key only your wallet can derive; the service cannot read it."
              : "The agent's reasoning is sealed to a key only your wallet can derive, so the service itself cannot read it. Unlock it with one wallet signature (no transaction, no fee)."}
          </p>
          {r.state === "open" ? (
            <button type="button" className="btn btn-quiet" onClick={r.lock}>
              Lock again
            </button>
          ) : (
            <button type="button" className="btn" disabled={r.state === "unlocking"} onClick={() => void r.unlock()}>
              {r.state === "unlocking" ? "Waiting for your wallet…" : "Unlock reasoning"}
            </button>
          )}
        </div>
      )}
      {r.error && (
        <div role="alert" className="text-alert">
          <p>{r.error}</p>
          {r.state === "error" && r.error.includes("different unlock key") && (
            <button type="button" className="btn btn-danger mt-3" onClick={() => void r.replaceKey()}>
              Start a new key
            </button>
          )}
        </div>
      )}
      </aside>
      <div className="min-w-0 lg:order-1">
        <ActivityList items={items} reasons={r.texts} />
      </div>
    </div>
  );
}
