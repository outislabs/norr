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
