import type { ValuePoint } from "./api";

export interface ChartGeometry {
  /** SVG path for the line, in a width x height box. Empty with fewer than two readings. */
  line: string;
  /** The same path closed down to the baseline, for the fill under the line. */
  area: string;
  min: number;
  max: number;
  first: number | null;
  last: number | null;
  from: number | null;
  to: number | null;
}

/**
 * Turns readings into SVG paths. The vertical range is padded so a flat vault is a flat line in the middle,
 * not a line stretched to fill the box (which would make a one-cent wobble look like a crash).
 */
export function chartGeometry(points: ValuePoint[], width: number, height: number, pad = 6): ChartGeometry {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const base = { first: first?.totalUsd ?? null, last: last?.totalUsd ?? null, from: first?.t ?? null, to: last?.t ?? null };
  if (sorted.length < 2 || !first || !last) return { line: "", area: "", min: base.first ?? 0, max: base.first ?? 0, ...base };
  const values = sorted.map((p) => p.totalUsd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const lo = span === 0 ? min - Math.max(1, min * 0.05) : min - span * 0.1;
  const hi = span === 0 ? max + Math.max(1, max * 0.05) : max + span * 0.1;
  const t0 = first.t;
  const dt = last.t - t0 || 1;
  const x = (t: number) => pad + ((t - t0) / dt) * (width - 2 * pad);
  const y = (v: number) => height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad);
  const pts = sorted.map((p) => `${x(p.t).toFixed(1)},${y(p.totalUsd).toFixed(1)}`);
  const line = `M${pts.join("L")}`;
  const area = `${line}L${x(last.t).toFixed(1)},${height - pad}L${x(first.t).toFixed(1)},${height - pad}Z`;
  return { line, area, min, max, ...base };
}
