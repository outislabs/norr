import type { RegistryEntry } from "./registry";
import { block, type Block } from "./types";

/** `GET https://shield.chaindefuser.com/incident`. Direction is carried but not used for matching. */
export interface ShieldIncident {
  scopeType: "chain" | "bridge" | "token" | "address";
  scopeValue: string;
  direction?: string;
  publicDescription?: string;
}

export type ShieldFeed = { status: "operational" } | { status: "incidents"; incidents: ShieldIncident[] };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Does this incident touch the asset (by chain, token id, or a bridge named in the id) or an address? */
export function incidentAffects(i: ShieldIncident, asset: RegistryEntry, addresses: string[] = []): boolean {
  switch (i.scopeType) {
    case "chain": return same(i.scopeValue, asset.chain);
    case "token": return same(i.scopeValue, asset.id);
    case "bridge": return asset.id.toLowerCase().includes(i.scopeValue.toLowerCase());
    case "address": return addresses.some((a) => same(a, i.scopeValue));
  }
}

/**
 * Whether this deployment reads the NEAR Intents incident feed (Shield). It is a deployment setting, decided only by
 * whether a partner key is configured (SHIELD_API_KEY), and it is reported to owners and agents everywhere:
 * - "active": the feed is checked for every trade that passes the rules, and fails closed (unreachable or an incident blocks);
 * - "not_configured": no key, so there is no feed to check; every other check still runs, and every answer says so.
 * NEAR Intents offers no keyless incident or status signal (checked 2026-11-04), so there is no lighter substitute.
 */
export type IncidentFeedStatus = "active" | "not_configured";

export const INCIDENT_FEED_NOT_CONFIGURED = "Incident feed: not configured (partner key pending)";

/** What every answer carries about the feed: its status, and the plain label when it is not configured. */
export const incidentFeedInfo = (s: IncidentFeedStatus): { status: IncidentFeedStatus; note?: string } =>
  s === "active" ? { status: "active" } : { status: "not_configured", note: INCIDENT_FEED_NOT_CONFIGURED };

/**
 * Pre-trade check against the incident feed. A null feed means the feed was unreachable:
 * fail closed by default, since this is a safety check. Pass `onUnavailable: "allow"` to fail open.
 */
export function checkShield(
  feed: ShieldFeed | null,
  asset: RegistryEntry,
  opts: { addresses?: string[]; onUnavailable?: "block" | "allow" } = {},
): Block | null {
  if (feed === null) {
    return opts.onUnavailable === "allow"
      ? null
      : block(
          "SHIELD_INCIDENT",
          "Trading is temporarily paused. Norr could not reach the NEAR Intents security feed, so it cannot confirm this trade is safe. " +
            "No trade was made and no funds moved. Wait a few minutes and retry the same request; do not switch to a different asset to work around this.",
        );
  }
  if (feed.status === "operational") return null;
  const hit = feed.incidents.find((i) => incidentAffects(i, asset, opts.addresses));
  if (!hit) return null;
  const detail = hit.publicDescription ? ` ${hit.publicDescription}` : "";
  return block("SHIELD_INCIDENT", `Active Shield incident on ${hit.scopeType} "${hit.scopeValue}" affects ${asset.symbol}.${detail}`);
}
