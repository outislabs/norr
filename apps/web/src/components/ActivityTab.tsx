import type { Api, ActivityItem } from "../lib/api";
import { useReasoning } from "../lib/useReasoning";
import { ActivityList } from "./ActivityList";

/** The activity timeline plus the control that unlocks the agent's sealed reasoning with the owner's wallet. */
export function ActivityTab({ api, account, vaultId, items, reload }: { api: Api; account: string; vaultId: string; items: ActivityItem[]; reload: () => void }) {
  const r = useReasoning(api, account, vaultId, items, reload);
  const sealed = items.some((i) => i.sealedReason);
  return (
    <div className="flex flex-col gap-6">
      {sealed && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-vault p-4">
          <p className="max-w-lg text-sm text-mist">
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
        <div role="alert" className="text-rust">
          <p>{r.error}</p>
          {r.state === "error" && r.error.includes("different unlock key") && (
            <button type="button" className="btn btn-danger mt-3" onClick={() => void r.replaceKey()}>
              Start a new key
            </button>
          )}
        </div>
      )}
      <ActivityList items={items} reasons={r.texts} />
    </div>
  );
}
