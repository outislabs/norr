import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger, LedgerEntry } from "./state";

/**
 * Encryption at rest, two layers:
 *
 *  - The agent's stated reasoning is sealed to the OWNER's public key. The service can write it but
 *    cannot read it back; only the owner's browser can open it, with a key derived from a wallet signature.
 *  - Everything else the service stores (ledger lines, vault counters) is encrypted with a service data
 *    key, because the service must read decisions to enforce caps and answer the agent. This protects disks
 *    and backups, not against whoever runs the service and holds the key; the TEE deployment is what
 *    seals that key away (see docs/PRIVACY.md).
 *
 * Owner box = ephemeral X25519 -> HKDF-SHA256 -> AES-256-GCM, chosen so a browser can open it with
 * plain WebCrypto and no extra libraries. The format is spelled out in apps/web/src/lib/seal.ts.
 */

export const SEAL_INFO = "norr-seal-v1";
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

export interface OwnerBox {
  v: 1;
  k: "owner";
  /** Ephemeral X25519 public key, base64 (32 bytes). */
  epk: string;
  iv: string;
  /** AES-GCM ciphertext with the 16-byte tag appended, base64. */
  ct: string;
}
/** Sealed to the service's data key because the owner has not enrolled a key yet; re-sealed to the owner on enrollment. */
export interface ServiceBox {
  v: 1;
  k: "service";
  iv: string;
  ct: string;
}
export type SealedReason = OwnerBox | ServiceBox;

function gcmEncrypt(key: Buffer, plaintext: string, aad: string): { iv: string; ct: string } {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final(), c.getAuthTag()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64") };
}

function gcmDecrypt(key: Buffer, box: { iv: string; ct: string }, aad: string): string {
  const ct = Buffer.from(box.ct, "base64");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8");
}

/** Encrypts the service's own files. Fails closed: a wrong or missing key stops startup, it never yields empty data. */
export class DataCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("The data key must be 32 bytes (base64 in NORR_DATA_KEY).");
  }

  static random(): DataCipher {
    return new DataCipher(randomBytes(32));
  }

  /**
   * NORR_DATA_KEY (base64, 32 bytes) when set: in production it comes from the enclave's sealed secrets.
   * Otherwise a development key is created next to the data. That protects against copying the data files
   * alone; it does not protect against someone who can read this directory.
   */
  static load(env: NodeJS.ProcessEnv, dir: string, warn: (m: string) => void = console.warn): DataCipher {
    if (env.NORR_DATA_KEY) return new DataCipher(Buffer.from(env.NORR_DATA_KEY, "base64"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "service.key");
    if (!existsSync(file)) {
      writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
      warn("NORR_DATA_KEY is not set: created a development data key in the data directory. Set NORR_DATA_KEY from sealed secrets in production.");
    }
    return new DataCipher(Buffer.from(readFileSync(file, "utf8").trim(), "base64"));
  }

  encrypt(plaintext: string, aad: string): { iv: string; ct: string } {
    return gcmEncrypt(this.key, plaintext, aad);
  }

  decrypt(box: { iv: string; ct: string }, aad: string): string {
    return gcmDecrypt(this.key, box, aad);
  }
}

const pubKeyOf = (b64: string): Buffer => {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) throw new Error("An owner key must be a 32-byte X25519 public key (base64).");
  return raw;
};

/** Seal to the owner's X25519 public key. `aad` ties the box to its vault so it cannot be moved to another. */
export function sealToOwner(plaintext: string, ownerPublicKeyB64: string, aad: string): OwnerBox {
  const owner = pubKeyOf(ownerPublicKeyB64);
  const eph = generateKeyPairSync("x25519");
  const epk = eph.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519, owner]), format: "der", type: "spki" }) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, owner]), SEAL_INFO, 32));
  return { v: 1, k: "owner", epk: epk.toString("base64"), ...gcmEncrypt(key, plaintext, aad) };
}

/** Owners' public sealing keys, by account. Public keys only: nothing secret is stored here. */
export interface SealKeyStore {
  get(owner: string): string | undefined;
  set(owner: string, publicKeyB64: string): void;
}

export class MemorySealKeys implements SealKeyStore {
  protected readonly keys = new Map<string, string>();
  get(owner: string): string | undefined {
    return this.keys.get(owner);
  }
  set(owner: string, key: string): void {
    pubKeyOf(key);
    this.keys.set(owner, key);
  }
}

export class FileSealKeys extends MemorySealKeys {
  private readonly file: string;
  constructor(dir: string) {
    super();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "seal-keys.json");
    if (existsSync(this.file)) for (const [o, k] of Object.entries(JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>)) this.keys.set(o, k);
  }
  override set(owner: string, key: string): void {
    super.set(owner, key);
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.keys), null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/**
 * A ledger that never stores the agent's reasoning in the clear. On every append the reason is removed
 * from the request and kept as a sealed box: to the owner's key if they have enrolled one, otherwise to the
 * service key until they do (then `reseal` moves it to the owner, and the service can no longer read it).
 */
export class SealingLedger implements Ledger {
  constructor(
    private readonly inner: Ledger,
    private readonly keys: SealKeyStore,
    private readonly cipher: DataCipher,
    /** The account that owns a vault, whose key reasoning is sealed to. */
    private readonly ownerOf: (vaultId: string) => string | undefined,
  ) {}

  private seal(vaultId: string, reason: string): SealedReason {
    const owner = this.ownerOf(vaultId);
    const key = owner ? this.keys.get(owner) : undefined;
    return key ? sealToOwner(reason, key, vaultId) : { v: 1, k: "service", ...this.cipher.encrypt(reason, vaultId) };
  }

  append(entry: Omit<LedgerEntry, "id">): LedgerEntry {
    const { reason } = entry.request;
    return this.inner.append({ ...entry, request: { ...entry.request, reason: "" }, ...(reason ? { sealedReason: this.seal(entry.vaultId, reason) } : {}) });
  }

  update(id: string, patch: Partial<Omit<LedgerEntry, "id">>): void {
    this.inner.update(id, patch);
  }

  get(id: string): LedgerEntry | undefined {
    return this.inner.get(id);
  }

  list(vaultId: string): LedgerEntry[] {
    return this.inner.list(vaultId);
  }

  /** Move reasoning sealed to the service over to the owner's key. Returns how many were moved. */
  reseal(vaultId: string, ownerPublicKeyB64: string): number {
    let n = 0;
    for (const r of this.inner.list(vaultId)) {
      if (r.sealedReason?.k !== "service") continue;
      this.inner.update(r.id, { sealedReason: sealToOwner(this.cipher.decrypt(r.sealedReason, vaultId), ownerPublicKeyB64, vaultId) });
      n++;
    }
    return n;
  }

  /** Seal any reasoning that an older version stored in the clear. Idempotent. */
  sealExisting(vaultId: string): number {
    let n = 0;
    for (const r of this.inner.list(vaultId)) {
      if (!r.request.reason || r.sealedReason) continue;
      this.inner.update(r.id, { request: { ...r.request, reason: "" }, sealedReason: this.seal(vaultId, r.request.reason) });
      n++;
    }
    return n;
  }
}
