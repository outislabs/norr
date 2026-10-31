import { DstackClient } from "@phala/dstack-sdk";
import type { AppInfo, AttestationEvidence } from "@norr/shared";
import { existsSync } from "node:fs";

/** What the service can get from the TEE it runs in. The only implementation talks to dstack's guest agent. */
export interface Attestor {
  /** A quote whose report data is the caller's nonce, so it cannot be replayed. */
  evidence(nonceHex: string): Promise<AttestationEvidence>;
  /** The application configuration the platform measured. */
  info(): Promise<AppInfo>;
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
