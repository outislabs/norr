import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./persist";

/**
 * Public-beta settings (docs/MULTI-USER.md). The operator switch for new vaults is changeable at run time through the
 * admin endpoint and kept across restarts; the rest come from the environment.
 */
export interface BetaSettings {
  /** New vaults may be created. Existing vaults keep working either way. */
  signupsOpen: boolean;
  /** Funding addresses past this vault value are refused, and buys pause above it. */
  depositCapUsd: number;
  /** Vaults across the whole service. */
  maxVaults: number;
  maxVaultsPerOwner: number;
  /** The terms and risk disclosure an owner must accept to create a vault. */
  termsVersion: string;
  termsUrl: string;
  /** Accounts that may create a vault while signups are closed (a staged launch). Never published. */
  allowlist?: string[];
}

/** The current terms. Changing the text means a new version; vaults keep the version their owner accepted. */
export const TERMS_VERSION = "2026-11-04";
export const TERMS_URL = "https://norr.finance/docs/terms/";

export class BetaControl {
  private open: boolean;
  constructor(private readonly base: Omit<BetaSettings, "signupsOpen"> & { signupsOpen: boolean }, private readonly file?: string) {
    this.open = base.signupsOpen;
    if (file && existsSync(file)) {
      try {
        this.open = (JSON.parse(readFileSync(file, "utf8")) as { signupsOpen?: boolean }).signupsOpen ?? this.open;
      } catch {
        this.open = false; // unreadable: closed is the safe reading
      }
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv, dataDir?: string): BetaControl {
    const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
    let file: string | undefined;
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      file = join(dataDir, "beta.json");
    }
    return new BetaControl(
      {
        signupsOpen: (env.NORR_SIGNUPS || "open") !== "closed",
        depositCapUsd: num(env.NORR_BETA_DEPOSIT_CAP_USD, 100),
        maxVaults: num(env.NORR_BETA_MAX_VAULTS, 50),
        maxVaultsPerOwner: num(env.NORR_BETA_MAX_VAULTS_PER_OWNER, 1),
        termsVersion: TERMS_VERSION,
        termsUrl: TERMS_URL,
        allowlist: (env.NORR_BETA_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      },
      file,
    );
  }

  get(): BetaSettings {
    return { ...this.base, signupsOpen: this.open };
  }

  setSignups(open: boolean): void {
    this.open = open;
    if (this.file) writeAtomic(this.file, JSON.stringify({ signupsOpen: open }));
  }
}

/** A sliding-window limiter, in memory: per owner account, per agent token, per IP. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  /** True if one more hit fits; records it when it does. */
  allow(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) this.hits.clear(); // bounded memory; a reset only loosens limits briefly
    return true;
  }
}
