import { allDone, type Step } from "../lib/onboarding";
import { vaultHref } from "../lib/route";

/** The first-run checklist on a vault's overview. It disappears once every step is done. */
export function Onboarding({ vaultId, steps }: { vaultId: string; steps: Step[] }) {
  if (allDone(steps)) return null;
  const next = steps.find((s) => !s.done);
  return (
    <section aria-label="Getting started" className="rounded-2xl border border-line p-5">
      <h2 className="font-display text-xl">Get started</h2>
      <p className="mt-1 text-sm text-mute">Four steps from an empty vault to an agent trading inside your rules.</p>
      <ol className="mt-3 flex flex-col">
        {steps.map((s, i) => (
          <li key={s.id} className="flex items-start gap-3 border-t border-line py-3 first:border-t-0">
            <span aria-hidden="true" className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${s.done ? "border-fg bg-fg text-bg" : s === next ? "border-fg text-fg" : "border-line-strong text-dim"}`}>
              {s.done ? "✓" : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={s.done ? "text-mute line-through decoration-line" : "text-fg"}>
                <span className="sr-only">{s.done ? "Done: " : "To do: "}</span>
                {s.title}
              </p>
              {!s.done && <p className="text-sm text-mute">{s.detail}</p>}
            </div>
            {!s.done && (
              <a href={vaultHref(vaultId, s.tab)} className={`btn shrink-0 ${s === next ? "btn-solid" : "btn-quiet"}`}>
                {s === next ? "Do this" : "Open"}
              </a>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
