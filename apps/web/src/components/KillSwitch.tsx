import { useState } from "react";

/** Always visible. Two steps on purpose: one tap to ask, one to confirm. */
export function KillSwitch({ onPauseAll }: { onPauseAll: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!asking) {
    return (
      <button type="button" className="btn btn-danger" onClick={() => setAsking(true)}>
        Pause everything
      </button>
    );
  }
  return (
    <div role="alertdialog" aria-label="Confirm pause" className="flex flex-col gap-2 border-l-2 border-rust pl-3 text-sm">
      <p className="text-ivory">Pause every vault now? Agents are refused until you resume each one.</p>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-danger btn-solid"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onPauseAll();
              setAsking(false);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not pause.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Pausing…" : "Yes, pause all"}
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => setAsking(false)}>
          Cancel
        </button>
      </div>
      {error && (
        <p role="alert" className="text-rust">
          {error}
        </p>
      )}
    </div>
  );
}
