import type { ValuePoint } from "../lib/api";
import { chartGeometry } from "../lib/chart";
import { usd } from "../lib/format";

const W = 600;
const H = 140;

/** The vault's total value over time. Readings come from the service (when you open the page, and every 15 minutes). */
export function ValueChart({ points }: { points: ValuePoint[] }) {
  const g = chartGeometry(points, W, H);
  if (!g.line) {
    return (
      <p className="text-sm text-mute">
        No history to draw yet. Norr takes a reading when you open this page and every 15 minutes while it runs; a line appears once there are two.
      </p>
    );
  }
  const change = g.last! - g.first!;
  const day = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Vault value from ${usd(g.first!)} to ${usd(g.last!)} between ${day(g.from!)} and ${day(g.to!)} UTC`} className="h-36 w-full">
        <path d={g.area} className="fill-fg/5" />
        <path d={g.line} className="fill-none stroke-fg" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="mt-1 flex flex-wrap justify-between gap-x-4 text-sm text-mute">
        <span className="mono">{day(g.from!)} to {day(g.to!)} UTC</span>
        <span className="mono">
          {usd(g.first!)} to {usd(g.last!)} ({change >= 0 ? "+" : "−"}
          {usd(Math.abs(change))})
        </span>
      </figcaption>
    </figure>
  );
}
