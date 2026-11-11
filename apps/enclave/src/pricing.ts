import { ONDO, Registry, extraTokens, type OneClickToken } from "@norr/core";

/** Where the asset list comes from: both 1Click token lists (plain, and with the Ondo extras). */
export type TokenSource = () => Promise<{ plain: OneClickToken[]; withOndo: OneClickToken[] }>;

export interface PricingFeedOptions {
  /** The cash asset (USDC) that must be in the list before trading is allowed. */
  cashAssetId: string;
  sleep: (ms: number) => Promise<void>;
  /** First retry delay; doubles up to `maxDelayMs`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called on each failed attempt, with a message that is safe to log (no keys, no balances). */
  onFailure?: (attempt: number, message: string) => void;
  onReady?: (attempts: number) => void;
  /** How often the loaded list (and with it every reference price) is reloaded. 0 turns the reload off. Default 60 s. */
  refreshMs?: number;
  /**
   * The oldest a reference price may be and still be used. Past this (1Click unreachable for a while) `ready()` is false and
   * trades block with PRICING_UNAVAILABLE, instead of comparing live quotes with an old price. Default 5 minutes.
   */
  maxAgeMs?: number;
  now?: () => number;
}

/**
 * Keeps the asset registry filled without making startup depend on 1Click. The service starts with an empty registry and
 * answers health, attestation and the dashboard at once; trades are blocked (PRICING_UNAVAILABLE) until the token list has
 * loaded, and a background loop retries with backoff until it does.
 *
 * After that the list is reloaded every `refreshMs`, because it carries the reference prices that price sanity checks quotes
 * against. (It used to load once, so a reference stayed at its boot-time value and every quote drifted away from it: SOL buys
 * blocked by a constant 2.5% gap.) A failed reload keeps the previous list; once it is older than `maxAgeMs` the feed reports
 * not ready, so trades fail closed rather than run against a stale reference.
 */
export class PricingFeed {
  readonly registry = new Registry({ crypto: [] });
  private loaded = false;
  private attempts = 0;
  private running: Promise<void> | null = null;
  private stopped = false;
  private loadedAtMs: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<boolean> | null = null;

  constructor(
    private readonly source: TokenSource,
    private readonly o: PricingFeedOptions,
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Loaded, and the reference prices are fresh enough to check quotes against. */
  ready(): boolean {
    if (!this.loaded || this.loadedAtMs === null) return false;
    return this.now() - this.loadedAtMs <= (this.o.maxAgeMs ?? 5 * 60_000);
  }

  /** When the current list (and its reference prices) was loaded, or null before the first load. */
  lastLoadedAt(): number | null {
    return this.loadedAtMs;
  }

  /** One attempt (concurrent calls share it). Returns true when the registry now holds a freshly loaded list. */
  refresh(): Promise<boolean> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<boolean> {
    this.attempts++;
    try {
      const { plain, withOndo } = await this.source();
      if (!plain.some((t) => t.assetId === this.o.cashAssetId)) throw new Error("USDC on NEAR is missing from the 1Click token list");
      this.registry.load({ crypto: plain, equities: [{ issuer: ONDO, tokens: extraTokens(plain, withOndo) }] });
      this.loadedAtMs = this.now();
      if (!this.loaded) {
        this.loaded = true;
        this.o.onReady?.(this.attempts);
      }
      return true;
    } catch (e) {
      this.o.onFailure?.(this.attempts, e instanceof Error ? e.message.replace(/\s+/g, " ").slice(0, 160) : "unknown error");
      return false;
    }
  }

  /** Starts the background loop (idempotent). The returned promise settles once the registry has loaded, or after `stop()`. */
  start(): Promise<void> {
    this.running ??= (async () => {
      let delay = this.o.baseDelayMs ?? 5_000;
      while (!this.stopped && !(await this.refresh())) {
        await this.o.sleep(delay);
        delay = Math.min(delay * 2, this.o.maxDelayMs ?? 60_000);
      }
      const every = this.o.refreshMs ?? 60_000;
      if (!this.stopped && every > 0) {
        this.timer = setInterval(() => void this.refresh(), every);
        this.timer.unref?.();
      }
    })();
    return this.running;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
