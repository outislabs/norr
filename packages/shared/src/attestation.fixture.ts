import { createHash } from "node:crypto";
import type { AppInfo, AttestationEvidence, EventLogEntry } from "./attestation";

/** Test support: quotes and event logs built to the documented TDX v4 layout. Not a real quote. */
export const sha = (alg: string, b: Buffer | string) => createHash(alg).update(b).digest();
/** dstack-0.5.12, a production OS image. */
export const PROD_OS = "8db40cb23008d6213668b5816702d100b37b859a8a5bfd18d938ae3a1b3715bd";
export const DEV_OS = "e866e987221db357129ebc3f066b6706ef955889ea95e5510acbdf3d3055186b";
export const DIGEST = "a".repeat(64);
export const compose = (image = `ghcr.io/outislabs/norr@sha256:${DIGEST}`) => JSON.stringify({ manifest_version: 2, name: "norr", runner: "docker-compose", docker_compose_file: `services:\n  norr:\n    image: ${image}\n    restart: unless-stopped\n` });

/** A quote with the documented TDX v4 layout: 48-byte header, then the body with RTMR3 and REPORTDATA at their offsets. */
export function buildQuote(o: { rtmr3: Buffer; reportData: Buffer; version?: number; teeType?: number }): string {
  const q = Buffer.alloc(48 + 584 + 4);
  q.writeUInt16LE(o.version ?? 4, 0);
  q.writeUInt16LE(2, 2);
  q.writeUInt32LE(o.teeType ?? 0x81, 4);
  o.rtmr3.copy(q, 48 + 472);
  o.reportData.copy(q, 48 + 520);
  return q.toString("hex");
}

/** dstack's digest for an RTMR3 event: SHA-384(event_type LE32 || ":" || event || ":" || payload). */
export const eventDigest = (type: number, event: string, payloadHex: string): string => {
  const t = Buffer.alloc(4);
  t.writeUInt32LE(type);
  return sha("sha384", Buffer.concat([t, Buffer.from(`:${event}:`), Buffer.from(payloadHex, "hex")])).toString("hex");
};

export function fixture(over: { appCompose?: string; nonce?: string; osImage?: string | null } = {}) {
  const os = over.osImage === undefined ? PROD_OS : over.osImage;
  const appCompose = over.appCompose ?? compose();
  const nonce = over.nonce ?? "11".repeat(32);
  const events: EventLogEntry[] = [
    { imr: 0, event_type: 1, digest: "00".repeat(48), event: "boot", event_payload: "" }, // another register: must not affect RTMR3
    { imr: 3, event_type: 134217729, digest: eventDigest(134217729, "app-id", "abcd"), event: "app-id", event_payload: "abcd" },
    { imr: 3, event_type: 134217729, digest: eventDigest(134217729, "compose-hash", sha("sha256", appCompose).toString("hex")), event: "compose-hash", event_payload: sha("sha256", appCompose).toString("hex") },
    ...(os === null ? [] : [{ imr: 3, event_type: 134217729, digest: eventDigest(134217729, "os-image-hash", os), event: "os-image-hash", event_payload: os }]),
    { imr: 3, event_type: 134217729, digest: eventDigest(134217729, "instance-id", "ff"), event: "instance-id", event_payload: "ff" },
  ];
  let rtmr = Buffer.alloc(48);
  for (const e of events) if (e.imr === 3) rtmr = sha("sha384", Buffer.concat([rtmr, Buffer.from(e.digest, "hex")])); // digests above are already the full 48 bytes
  const reportData = Buffer.alloc(64);
  Buffer.from(nonce, "hex").copy(reportData);
  const evidence: AttestationEvidence = { quote: buildQuote({ rtmr3: rtmr, reportData }), eventLog: JSON.stringify(events) };
  const info: AppInfo = { appCompose };
  return { nonce, evidence, info, events, rtmr };
}

