import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CustodyPolicy } from "@norr/core";
import { withLock, writeAtomic } from "./persist";
import type { DataCipher } from "./seal";

/**
 * Self-serve vaults (docs/MULTI-USER.md): one record per vault created in the dashboard, and that vault's custody key.
 * Each is its own file, encrypted with the service data key and bound to its vault id (AES-GCM associated data), so a
 * record or key copied to another vault's file does not decrypt. Keys are never returned by any route.
 */
export interface TenantRecord {
  id: string;
  /** The owner's name for the vault. */
  name?: string;
  /** The NEAR account that created the vault: its only owner and approver, and the custody policy's controller. */
  owner: string;
  walletId: string;
  /** The custody wallet's implicit account. */
  walletAccount: string;
  /** `setup` until the owner's policy is on chain and checked; then `active`. */
  status: "setup" | "active";
  createdAt: string;
  activatedAt?: string;
  terms: { version: string; acceptedAt: string };
  nonUsConfirmed: boolean;
  /** The policy Norr prepared for the owner to store, and its key on chain. */
  custody?: {
    policy: CustodyPolicy;
    walletPubkey: string;
    autonomous: boolean;
    maxTradeUsd: number;
    dailyCapUsd: number;
    preparedAt: string;
    /** A switch of autonomous mode the owner has been asked to sign, until the chain shows it (or it is replaced). */
    pending?: { autonomous: boolean; policy: CustodyPolicy; preparedAt: string };
  };
}

export interface TenantStore {
  /** Vault ids only (cheap: no decryption). */
  ids(): string[];
  list(): TenantRecord[];
  get(id: string): TenantRecord | undefined;
  put(r: TenantRecord): void;
  setKey(id: string, apiKey: string): void;
  key(id: string): string | undefined;
}

export class MemoryTenantStore implements TenantStore {
  private readonly records = new Map<string, TenantRecord>();
  private readonly keys = new Map<string, string>();
  ids(): string[] {
    return [...this.records.keys()];
  }
  list(): TenantRecord[] {
    return [...this.records.values()].map((r) => structuredClone(r));
  }
  get(id: string): TenantRecord | undefined {
    const r = this.records.get(id);
    return r ? structuredClone(r) : undefined;
  }
  put(r: TenantRecord): void {
    this.records.set(r.id, structuredClone(r));
  }
  setKey(id: string, apiKey: string): void {
    this.keys.set(id, apiKey);
  }
  key(id: string): string | undefined {
    return this.keys.get(id);
  }
}

const SAFE_ID = /^v_[a-z0-9]{8,40}$/;

/** `<dir>/tenants/<id>.json` (the record) and `<id>.key` (the custody key), each encrypted and bound to the id. */
export class FileTenantStore implements TenantStore {
  private readonly dir: string;
  constructor(dataDir: string, private readonly cipher: DataCipher) {
    this.dir = join(dataDir, "tenants");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private file(id: string, ext: "json" | "key"): string {
    if (!SAFE_ID.test(id)) throw new Error("invalid vault id");
    return join(this.dir, `${id}.${ext}`);
  }

  private read<T>(id: string, ext: "json" | "key", aad: string): T | undefined {
    const f = this.file(id, ext);
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(this.cipher.decrypt(JSON.parse(readFileSync(f, "utf8")), aad)) as T;
    } catch {
      throw new Error(`Vault ${id}: ${ext === "key" ? "custody key" : "record"} is unreadable (damaged, moved from another vault, or the data key is wrong). Not starting.`);
    }
  }

  ids(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((id) => SAFE_ID.test(id));
  }

  list(): TenantRecord[] {
    return this.ids()
      .map((id) => this.get(id)!)
      .filter(Boolean);
  }

  get(id: string): TenantRecord | undefined {
    if (!SAFE_ID.test(id)) return undefined;
    return this.read<TenantRecord>(id, "json", `tenant:${id}`);
  }

  put(r: TenantRecord): void {
    withLock(this.dir, () => writeAtomic(this.file(r.id, "json"), JSON.stringify(this.cipher.encrypt(JSON.stringify(r), `tenant:${r.id}`))));
  }

  setKey(id: string, apiKey: string): void {
    withLock(this.dir, () => writeAtomic(this.file(id, "key"), JSON.stringify(this.cipher.encrypt(JSON.stringify(apiKey), `custody-key:${id}`))));
  }

  key(id: string): string | undefined {
    if (!SAFE_ID.test(id)) return undefined;
    return this.read<string>(id, "key", `custody-key:${id}`);
  }
}
