import { dayKey } from "./pnl";

/** A running USD total for one UTC day. Used for the daily spend cap. Pure; no I/O. */
export interface DaySum {
  day: string;
  usd: number;
}

export const emptyDay = (ms: number): DaySum => ({ day: dayKey(ms), usd: 0 });

/** Add to today's total; a new UTC day starts again from the amount. */
export function addToDay(t: DaySum, ms: number, usd: number): DaySum {
  const day = dayKey(ms);
  return t.day === day ? { day, usd: t.usd + usd } : { day, usd };
}

export const sumToday = (t: DaySum, ms: number): number => (t.day === dayKey(ms) ? t.usd : 0);

/** Give back a reservation made on `day`. If the day has since rolled over there is nothing to give back. */
export function releaseFromDay(t: DaySum, day: string, usd: number): DaySum {
  return t.day === day ? { day, usd: Math.max(0, t.usd - usd) } : t;
}
