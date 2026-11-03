import { useState } from "react";

/**
 * Always visible in the header. Two steps on purpose: one tap to ask, one to confirm. The confirmation drops
 * down under the button, so the header keeps its single row.
 */
export function KillSwitch({ onPauseAll }: { onPauseAll: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="relative">
      <button type="button" className="btn btn-danger min-h-10 px-4 text-sm" aria-expanded={asking} onClick={() => setAsking((a) => !a)}>
        Pause everything
      </button>
      {asking && (
        <div role="alertdialog" aria-label="Confirm pause" className="absolute right-0 top-full z-20 mt-2 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-3 rounded-2xl border border-line-strong bg-bg p-4 text-sm">
          <p className="text-fg">Pause every vault now? Agents are refused until you resume each one.</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-danger btn-solid min-h-10 px-4 text-sm"
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
            <button type="button" className="btn btn-quiet min-h-10 px-4 text-sm" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
          {error && (
            <p role="alert" className="text-fg">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
