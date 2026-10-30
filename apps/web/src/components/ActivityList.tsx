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

const TONE = { ok: "text-verdigris", stop: "text-rust", wait: "text-brass", bad: "text-rust" } as const;

export function ActivityList({ items, now }: { items: ActivityItem[]; now?: number }) {
  if (items.length === 0) return <p className="text-mist">Nothing yet. When the agent trades, or tries to, it shows up here.</p>;
  return (
    <ol className="flex flex-col">
      {items.map((it) => {
        const d = describe(it.decision);
        return (
          <li key={it.id} className="border-t border-line py-4 first:border-t-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-ivory">
                <span className={`${TONE[d.tone]} font-medium`}>{d.label}</span>
                <span className="mx-2 text-mist">·</span>
                {it.side === "buy" ? "Buy" : "Sell"} {usd(it.amountUsd)} of {it.asset}
              </p>
              <time className="text-sm text-mist" dateTime={it.at}>
                {ago(it.at, now)}
              </time>
            </div>
            <p className="mt-1 text-sm text-mist">{d.detail}</p>
            {it.decision.status === "executed" && it.decision.warnings?.map((w) => (
              <p key={w} className="mt-1 text-sm text-brass">
                {w}
              </p>
            ))}
            {it.reason && (
              <blockquote className="mt-2 border-l-2 border-brass-deep pl-3 text-sm italic text-mist">
                <span className="not-italic text-ivory">The agent's reasoning, visible only to you: </span>
                {it.reason}
              </blockquote>
            )}
            {it.note && <p className="mt-1 text-sm text-rust">Note: {it.note}</p>}
          </li>
        );
      })}
    </ol>
  );
}
