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
}

/**
 * Keeps the asset registry filled without making startup depend on 1Click. The service starts with an empty registry and
 * answers health, attestation and the dashboard at once; trades are blocked (PRICING_UNAVAILABLE) until the token list has
 * loaded, and a background loop retries with backoff until it does. It loads once: a later 1Click outage does not empty the
 * registry, and quotes already fail per trade when 1Click is down.
 */
export class PricingFeed {
  readonly registry = new Registry({ crypto: [] });
  private loaded = false;
  private attempts = 0;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly source: TokenSource,
    private readonly o: PricingFeedOptions,
  ) {}

  ready(): boolean {
    return this.loaded;
  }

  /** One attempt. Returns true when the registry is now loaded. */
  async refresh(): Promise<boolean> {
    this.attempts++;
    try {
      const { plain, withOndo } = await this.source();
      if (!plain.some((t) => t.assetId === this.o.cashAssetId)) throw new Error("USDC on NEAR is missing from the 1Click token list");
      this.registry.load({ crypto: plain, equities: [{ issuer: ONDO, tokens: extraTokens(plain, withOndo) }] });
      this.loaded = true;
      this.o.onReady?.(this.attempts);
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
    })();
    return this.running;
  }

  stop(): void {
    this.stopped = true;
  }
}
