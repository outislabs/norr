import { useState } from "react";
import type { Api } from "../lib/api";
import { vaultLabel } from "../lib/format";

/** The vault's name as the page title, with an inline rename. The id stays visible underneath for support and logs. */
export function VaultTitle({ api, vault, onRenamed }: { api: Api; vault: { id: string; name?: string | null }; onRenamed?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(vault.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="font-display break-words text-3xl">{vaultLabel(vault)}</h1>
          <button type="button" className="text-sm text-mute underline decoration-line-strong underline-offset-4 hover:text-fg" onClick={() => (setName(vault.name ?? ""), setEditing(true))}>
            Rename
          </button>
        </div>
        {vault.name && <p className="mono mt-1 text-xs text-dim">{vault.id}</p>}
      </div>
    );
  }
  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.renameVault(vault.id, name);
          setEditing(false);
          onRenamed?.();
        } catch (err) {
          setError(err instanceof Error ? err.message : "The name was not saved.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="label" htmlFor="rename-vault">Vault name</label>
      <div className="flex flex-wrap gap-2">
        <input id="rename-vault" className="field max-w-sm" value={name} maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn btn-solid" disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-fg">{error}</p>}
    </form>
  );
}
