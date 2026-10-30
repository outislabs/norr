import type { ShieldFeed, ShieldIncident } from "@norr/core";
import { obj, requestJson, str, type FetchLike } from "./http";

export interface ShieldClientOptions {
  /** A key of type SHIELD from partners.near-intents.org (the 1Click distribution key is rejected). */
  apiKey: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Reuse a successful read for this long. */
  ttlMs?: number;
}

const SCOPES = new Set(["chain", "bridge", "token", "address"]);

/** NEAR Intents Shield incident feed. Returns null when unreachable, so the check fails closed. */
export class ShieldClient {
  private readonly f: FetchLike;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cached: { at: number; feed: ShieldFeed } | null = null;

  constructor(private readonly o: ShieldClientOptions) {
    this.f = o.fetch ?? ((url, init) => fetch(url, init));
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? 15_000;
  }

  feed = async (): Promise<ShieldFeed | null> => {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.feed;
    try {
      const res = obj(
        await requestJson(this.f, "https://shield.chaindefuser.com/incident", { headers: { accept: "application/json", "user-agent": "norr/0.1", authorization: `Bearer ${this.o.apiKey}` } }, "Shield"),
      );
      let feed: ShieldFeed;
      if (res.status === "operational") feed = { status: "operational" };
      else if (res.status === "incidents" && Array.isArray(res.incidents)) {
        const incidents: ShieldIncident[] = [];
        for (const raw of res.incidents) {
          const i = obj(raw);
          const scopeType = str(i.scopeType);
          const scopeValue = str(i.scopeValue);
          // An incident we cannot read still counts: fail closed on the whole feed.
          if (!scopeType || !SCOPES.has(scopeType) || !scopeValue) return null;
          incidents.push({ scopeType: scopeType as ShieldIncident["scopeType"], scopeValue, direction: str(i.direction), publicDescription: str(i.publicDescription) });
        }
        feed = { status: "incidents", incidents };
      } else return null;
      this.cached = { at: this.now(), feed };
      return feed;
    } catch {
      return null;
    }
  };
}
