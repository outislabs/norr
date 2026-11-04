import { useState } from "react";
import type { Api } from "../lib/api";
import { useAsync } from "../lib/useAsync";

/**
 * The OAuth consent screen for MCP connectors (the Claude app and others): which app asks, where it will be sent back,
 * and which one vault it may use. Saying yes gives it what an agent token gives (read, quote, trade within the rules);
 * it can be revoked any time in the vault's Connect tab.
 */
export function AuthorizePage({ api, account, rid, go = (url) => window.location.assign(url) }: { api: Api; account: string; rid: string; go?: (url: string) => void }) {
  const req = useAsync(() => api.oauthRequest(rid), `oauth-${rid}`);
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(yes: boolean, vault: string | null) {
    setBusy(true);
    setError(null);
    try {
      const r = yes && vault ? await api.oauthApprove(rid, vault) : await api.oauthDeny(rid);
      go(r.redirect);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
      setBusy(false);
    }
  }

  if (req.loading) return <p className="text-mute">Loading…</p>;
  if (req.error || !req.data) {
    return (
      <section className="max-w-xl">
        <h1 className="font-display text-3xl">Connect an app</h1>
        <p className="mt-3 text-mute">{req.error ?? "This sign-in request has expired or was already used. Start again from your app."}</p>
      </section>
    );
  }
  const r = req.data;
  const chosen = vaultId ?? (r.vaults.length === 1 ? r.vaults[0]!.id : null);

  return (
    <section className="flex max-w-xl flex-col gap-6">
      <div>
        <p className="eyebrow">Connect an app</p>
        <h1 className="font-display mt-1 text-3xl">{r.clientName} wants to trade for you</h1>
        <p className="mt-2 text-mute">
          Signed in as <span className="mono">{account}</span>. After you approve, you go back to <span className="mono">{r.redirectHost}</span>.
        </p>
      </div>
      <ul className="flex flex-col gap-1 text-sm text-mute">
        <li>It can read one vault, get quotes and trade within that vault's rules.</li>
        <li>It cannot withdraw, change the rules, or choose where money goes.</li>
        <li>You can disconnect it any time in the vault's Connect tab.</li>
      </ul>
      {r.vaults.length === 0 ? (
        <p className="border-l border-line-strong pl-3 text-fg">You have no active vault yet. Create one first, then connect the app again.</p>
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="label">Which vault may it use?</legend>
          {r.vaults.map((v) => (
            <label key={v.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-line px-3 py-3">
              <input type="radio" name="vault" className="accent-white" checked={chosen === v.id} onChange={() => setVaultId(v.id)} />
              <span className="mono">{v.id}</span>
              {v.paused && <span className="text-sm text-mute">paused</span>}
            </label>
          ))}
        </fieldset>
      )}
      {error && <p role="alert" className="border-l border-line-strong pl-3 text-sm text-fg">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-solid" disabled={!chosen || busy} onClick={() => void answer(true, chosen)}>
          Approve
        </button>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void answer(false, null)}>
          Deny
        </button>
      </div>
    </section>
  );
}
