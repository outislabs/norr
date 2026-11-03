import type { Decision } from "@norr/shared";
import { ago, usd } from "../lib/format";
import type { ActivityItem } from "../lib/api";

export function describe(d: Decision): { label: string; tone: "ok" | "stop" | "wait" | "bad"; detail: string } {
  switch (d.status) {
    case "executed":
      return {
        label: "Done",
        tone: "ok",
        detail: `${d.filled.amount} ${d.filled.asset}${d.venue ? `, ${d.venue === "confidential" ? "confidentially" : "publicly"}` : ""}${d.verification === "custody-reported" ? ", checked against the custody provider's own balances" : d.verification === "independent" ? ", independently verified" : ""}`,
      };
    case "blocked":
      return { label: "Refused", tone: "stop", detail: `${d.code}: ${d.message}` };
    case "pending_approval":
      return { label: "Waiting for you", tone: "wait", detail: d.message };
    default:
      return { label: d.status === "refunded" ? "Refunded" : "Failed", tone: "bad", detail: d.message };
  }
}

/** What happened. A trade that ran shows what it really moved; anything else shows what was asked for. */
function headline(it: ActivityItem): string {
  const buy = it.side === "buy";
  if (it.decision.status === "executed" && it.executed) {
    const base = buy ? `Bought ${it.asset}, spent ${usd(it.executed.usd)}` : `Sold ${it.asset}, received ${usd(it.executed.usd)}`;
    const r = it.executed.realizedUsd;
    return r === null ? base : `${base} (${r < 0 ? "realized loss" : "realized gain"} ${usd(Math.abs(r))})`;
  }
  return `${buy ? "Buy" : "Sell"} ${usd(it.amountUsd)} of ${it.asset}`;
}

// Black and white: the status word carries the meaning; waiting is the one quieter state.
const TONE = { ok: "text-fg", stop: "text-fg", wait: "text-mute", bad: "text-fg" } as const;

/** `reasons` holds the reasoning the owner has unlocked, by entry id. Anything else stays sealed. */
export function ActivityList({ items, now, reasons = {} }: { items: ActivityItem[]; now?: number; reasons?: Record<string, string> }) {
  if (items.length === 0) return <p className="text-mute">Nothing yet. When the agent trades, or tries to, it shows up here.</p>;
  return (
    <ol className="flex flex-col">
      {items.map((it) => {
        const d = describe(it.decision);
        return (
          <li key={it.id} className="border-t border-line py-4 first:border-t-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-fg">
                <span className={`${TONE[d.tone]} font-medium`}>{d.label}</span>
                <span className="mx-2 text-mute">·</span>
                {headline(it)}
              </p>
              <time className="text-sm text-mute" dateTime={it.at}>
                {ago(it.at, now)}
              </time>
            </div>
            <p className="mt-1 text-sm text-mute">{d.detail}</p>
            {it.decision.status === "executed" && it.decision.warnings?.map((w) => (
              <p key={w} className="mt-1 text-sm text-accent">
                {w}
              </p>
            ))}
            {it.sealedReason && reasons[it.id] !== undefined ? (
              <blockquote className="mt-2 border-l border-line-strong pl-3 text-sm italic text-mute">
                <span className="not-italic text-fg">The agent's reasoning, visible only to you: </span>
                {reasons[it.id]}
              </blockquote>
            ) : it.sealedReason ? (
              <p className="mt-2 border-l border-line pl-3 text-sm text-mute">The agent's reasoning is sealed. Unlock it to read it.</p>
            ) : null}
            {it.note && <p className="mt-1 text-sm text-alert">Note: {it.note}</p>}
          </li>
        );
      })}
    </ol>
  );
}
