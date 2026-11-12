import type { BetaControl } from "./beta";
import type { Onboarding } from "./onboarding";
import { readPortfolio } from "./owner/routes";
import type { TradeDeps } from "./trade";

/**
 * The operator's overview (`GET /admin/v1/overview`, admin token only). AGGREGATES ONLY: counts, totals and rates across
 * all vaults. It never returns an owner, a vault id, a token, a balance, a position, a trade or a reason, so running the
 * service does not mean reading anyone's strategy. Alerts name a condition, never a person.
 */

const HOUR = 3_600_000;
const hourStart = (t: number) => Math.floor(t / HOUR) * HOUR;

/** Hourly counts of failures the service itself saw (5xx) and of requests it rate-limited (429), in memory since start. */
export class RequestCounters {
  private readonly buckets = new Map<number, { s5xx: number; s429: number }>();
  readonly since: number;
  constructor(private readonly now: () => number = Date.now) {
    this.since = now();
  }
  record(status: number): void {
    if (status < 500 && status !== 429) return;
    const k = hourStart(this.now());
    const b = this.buckets.get(k) ?? { s5xx: 0, s429: 0 };
    if (status === 429) b.s429++;
    else b.s5xx++;
    this.buckets.set(k, b);
    for (const old of this.buckets.keys()) if (old < k - 48 * HOUR) this.buckets.delete(old);
  }
  at(hour: number): { s5xx: number; s429: number } {
    return this.buckets.get(hour) ?? { s5xx: 0, s429: 0 };
  }
}

export interface Reach {
  ok: boolean;
  /** HTTP status, or null when nothing answered. */
  status: number | null;
  ms: number;
}
export interface UpstreamHealth {
  oneClick: Reach;
  outLayer: Reach;
}

/** Is the upstream answering? Any answer below 500 counts as reachable except where `okStatus` says otherwise. */
export async function probe(url: string, o: { okStatus?: number; timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<Reach> {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const t0 = now();
  try {
    const r = await f(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 5000), headers: { accept: "application/json" } });
    return { ok: o.okStatus ? r.status === o.okStatus : r.status < 500, status: r.status, ms: now() - t0 };
  } catch {
    return { ok: false, status: null, ms: now() - t0 };
  }
}

export const liveProbes = (): Promise<UpstreamHealth> =>
  Promise.all([
    probe("https://1click.chaindefuser.com/v0/tokens", { okStatus: 200 }),
    // A public route; an unknown id answers 404, which still shows the gateway is up.
    probe("https://api.outlayer.ai/wallet/v1/approval/00000000-0000-4000-8000-000000000000"),
  ]).then(([oneClick, outLayer]) => ({ oneClick, outLayer }));

export interface Alert {
  level: "alert" | "warn";
  code: string;
  message: string;
}

export interface OperatorDeps {
  deps: TradeDeps;
  beta: BetaControl;
  onboarding?: Onboarding;
  counters: RequestCounters;
  mock: boolean;
  /** Overridable for tests; defaults to real probes (none in mock mode). */
  probes?: () => Promise<UpstreamHealth>;
}

/** Slow reads (upstream probes, vault balances) are cached for a minute so polling the overview cannot hammer them. */
const cache = new WeakMap<object, { at: number; value: unknown }>();
async function cached<T>(key: object, now: number, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: now, value });
  return value;
}

export async function operatorOverview(d: OperatorDeps) {
  const now = d.deps.now();
  const b = d.beta.get();
  const vaults = d.deps.vaults.list();
  const records = d.onboarding?.summaries() ?? [];
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const createdAt = records.map((r) => Date.parse(r.createdAt));

  // Value across vaults against the cap: a total and a count, never a per-vault figure.
  const ttl = d.mock ? 0 : 60_000;
  const funds = await cached(d.deps.vaults, now, ttl, async () => {
    const read = await Promise.all(vaults.map((v) => Promise.race([readPortfolio(d.deps, v), new Promise<null>((r) => setTimeout(() => r(null), 8000))])));
    const values = read.filter((p): p is NonNullable<typeof p> => p !== null).map((p) => p.totalUsd);
    return {
      totalUsd: Math.round(values.reduce((s, x) => s + x, 0) * 100) / 100,
      read: values.length,
      unreadable: vaults.length - values.length,
      nearCap: values.filter((x) => x >= b.depositCapUsd * 0.8 && x <= b.depositCapUsd).length,
      overCap: values.filter((x) => x > b.depositCapUsd).length,
    };
  });

  // What the agents' trades came to in the last 24 hours, by hour and outcome. Counts only.
  const hours = Array.from({ length: 24 }, (_, i) => hourStart(now) - (23 - i) * HOUR);
  const byHour = new Map(hours.map((h) => [h, { executed: 0, blocked: 0, failed: 0, refunded: 0, pending: 0 }]));
  const blockedByCode: Record<string, number> = {};
  for (const v of vaults) {
    for (const row of d.deps.ledger.list(v.id)) {
      const cell = byHour.get(hourStart(row.at));
      if (!cell) continue;
      const s = row.decision.status;
      if (s === "executed") cell.executed++;
      else if (s === "blocked") {
        cell.blocked++;
        blockedByCode[row.decision.code] = (blockedByCode[row.decision.code] ?? 0) + 1;
      } else if (s === "failed") cell.failed++;
      else if (s === "refunded") cell.refunded++;
      else cell.pending++;
    }
  }
  const perHour = hours.map((h) => ({ hour: new Date(h).toISOString(), ...byHour.get(h)!, ...d.counters.at(h) }));
  const last = perHour[perHour.length - 1]!;

  const upstream: UpstreamHealth | null = d.mock && !d.probes ? null : await cached(d.counters, now, ttl, d.probes ?? liveProbes);
  const feedConfigured = (d.deps.incidentFeed ?? "active") === "active";
  const feed = feedConfigured ? await d.deps.shield().catch(() => null) : undefined;
  const pricing = d.deps.pricingReady?.() === false ? "retrying" : "ready";

  const alerts: Alert[] = [];
  if (upstream && !upstream.oneClick.ok) alerts.push({ level: "alert", code: "ONECLICK_DOWN", message: `1Click is not answering as expected (${upstream.oneClick.status ?? "no answer"}): quotes, funding and trades will fail.` });
  if (upstream && !upstream.outLayer.ok) alerts.push({ level: "alert", code: "OUTLAYER_DOWN", message: `The OutLayer gateway is not answering (${upstream.outLayer.status ?? "no answer"}): custody operations and approvals will fail.` });
  if (pricing === "retrying") alerts.push({ level: "warn", code: "PRICING_RETRYING", message: "Pricing is not ready: trades are refused until the asset list loads." });
  if (feedConfigured && feed === null) alerts.push({ level: "warn", code: "SHIELD_UNREACHABLE", message: "The NEAR Intents incident feed is configured but unreachable: trades are refused (it fails closed)." });
  if (last.s5xx >= 5) alerts.push({ level: "alert", code: "ERRORS_HIGH", message: `${last.s5xx} server errors in the current hour.` });
  else if (last.s5xx >= 1) alerts.push({ level: "warn", code: "ERRORS", message: `${last.s5xx} server error${last.s5xx === 1 ? "" : "s"} in the current hour.` });
  const lastTwo = perHour.slice(-2);
  const failedRecent = lastTwo.reduce((s, h) => s + h.failed + h.refunded, 0);
  if (failedRecent >= 3) alerts.push({ level: "alert", code: "SWAPS_FAILING", message: `${failedRecent} swaps failed or were refunded in the last two hours.` });
  const blockedRecent = lastTwo.reduce((s, h) => s + h.blocked, 0);
  if (blockedRecent >= 30) alerts.push({ level: "warn", code: "REFUSALS_HIGH", message: `${blockedRecent} trades were refused in the last two hours (an agent may be looping).` });
  if (last.s429 >= 20) alerts.push({ level: "warn", code: "RATE_LIMITED", message: `${last.s429} requests were rate-limited in the current hour.` });
  const used = records.length;
  if (used >= b.maxVaults) alerts.push({ level: "alert", code: "BETA_FULL", message: `The beta is full (${used} of ${b.maxVaults} vaults): new signups are refused.` });
  else if (used >= b.maxVaults * 0.8) alerts.push({ level: "warn", code: "BETA_NEARLY_FULL", message: `${used} of ${b.maxVaults} vaults are used.` });
  if (funds.overCap > 0) alerts.push({ level: "warn", code: "OVER_CAP", message: `${funds.overCap} vault${funds.overCap === 1 ? " holds" : "s hold"} more than the $${b.depositCapUsd} beta cap (buys pause above it).` });
  if (funds.unreadable > 0) {
    // The latest reason (the custody provider's operation limit, an outage, a Norr fault), with when it was seen.
    const why = d.deps.balanceHealth?.current();
    alerts.push({ level: "warn", code: "BALANCES_UNREADABLE", message: `${funds.unreadable} vault balance${funds.unreadable === 1 ? "" : "s"} could not be read; totals are partial.${why ? ` Latest reason (${new Date(why.at).toISOString().slice(11, 16)} UTC, ${why.failure.source}, ${why.failure.code}): ${why.failure.reason}` : ""}` });
  }
  if (!b.signupsOpen) alerts.push({ level: "warn", code: "SIGNUPS_CLOSED", message: "New signups are closed." });

  return {
    at: new Date(now).toISOString(),
    note: "Aggregates only: no owners, vault ids, balances, trades or reasons.",
    signups: { open: b.signupsOpen, createdToday: createdAt.filter((t) => t >= dayStart).length, createdLast7Days: createdAt.filter((t) => t >= dayStart - 6 * 86_400_000).length },
    vaults: { total: used, active: records.filter((r) => r.status === "active").length, inSetup: records.filter((r) => r.status === "setup").length, pausedOfRunning: vaults.filter((v) => v.policy.paused).length, runningVaults: vaults.length, limit: b.maxVaults, perOwnerLimit: b.maxVaultsPerOwner },
    deposits: { totalValueUsd: funds.totalUsd, capPerVaultUsd: b.depositCapUsd, ceilingUsd: b.maxVaults * b.depositCapUsd, vaultsNearCap: funds.nearCap, vaultsOverCap: funds.overCap, balancesRead: funds.read, balancesUnreadable: funds.unreadable },
    health: { oneClick: upstream?.oneClick ?? "mock", outLayer: upstream?.outLayer ?? "mock", pricing, incidentFeed: !feedConfigured ? "not_configured" : feed === null ? "unreachable" : feed?.status === "operational" ? "ok" : "incidents" },
    last24Hours: { perHour, blockedByCode, errorsSince: new Date(d.counters.since).toISOString() },
    alerts,
  };
}
