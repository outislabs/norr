import { DstackClient } from "@phala/dstack-sdk";
import type { AppInfo, AttestationEvidence } from "@norr/shared";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

/** The path the enclave derives Norr's data key from (docs/OPERATOR-PRIVACY.md, option A). The same path always gives the same key. */
export const DATA_KEY_PATH = "norr/data-key/v1";

/**
 * A short one-way fingerprint of a key: the first 8 bytes of SHA-256 over a fixed label and the key. It reveals nothing
 * usable about the key (a hash of a 256-bit key), and lets anyone see that the enclave derives the SAME key after a
 * restart or a code update, which is the one claim the move to an enclave-derived key rests on.
 */
export function keyFingerprint(key: Uint8Array): string {
  return createHash("sha256").update("norr/key-fingerprint/v1\0").update(key).digest("hex").slice(0, 16);
}

/** What the service can get from the TEE it runs in. The only implementation talks to dstack's guest agent. */
export interface Attestor {
  /** A quote whose report data is the caller's nonce, so it cannot be replayed. */
  evidence(nonceHex: string): Promise<AttestationEvidence>;
  /** The application configuration the platform measured. */
  info(): Promise<AppInfo>;
  /** The fingerprint (never the key) of the key the enclave derives for `path`. Absent on an attestor that cannot derive keys. */
  keyFingerprint?(path: string): Promise<string>;
}

const SOCKETS = ["/var/run/dstack.sock", "/run/dstack.sock", "/var/run/dstack/dstack.sock"];

/** The attestor for this machine, or null when there is no TEE to ask (a laptop, the mock service). */
export function dstackAttestor(env: NodeJS.ProcessEnv = process.env): Attestor | null {
  const endpoint = env.DSTACK_SIMULATOR_ENDPOINT || SOCKETS.find((s) => existsSync(s));
  if (!endpoint) return null;
  const client = new DstackClient(endpoint);
  return {
    async evidence(nonceHex) {
      const q = await client.getQuote(Buffer.from(nonceHex, "hex"));
      return { quote: q.quote, eventLog: q.event_log, ...(q.vm_config ? { vmConfig: q.vm_config } : {}), reportData: nonceHex };
    },
    async keyFingerprint(path) {
      const { key } = await client.getKey(path);
      try {
        return keyFingerprint(key);
      } finally {
        key.fill(0); // step 1 only fingerprints the key; nothing keeps it
      }
    },
    async info() {
      const i = await client.info();
      const tcb = typeof i.tcb_info === "string" ? (JSON.parse(i.tcb_info) as { app_compose: string }) : i.tcb_info;
      return { appId: i.app_id, instanceId: i.instance_id, composeHash: i.compose_hash, appCompose: tcb.app_compose, osImageHash: i.os_image_hash };
    },
  };
}

/** At most `limit` calls per `windowMs`, for everyone together: quotes cost the TEE a little, and these endpoints are public. */
export function rateLimiter(limit: number, windowMs: number, now: () => number = Date.now): () => boolean {
  let stamps: number[] = [];
  return () => {
    const t = now();
    stamps = stamps.filter((s) => t - s < windowMs);
    if (stamps.length >= limit) return false;
    stamps.push(t);
    return true;
  };
}
