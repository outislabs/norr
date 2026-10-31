import { createHash } from "node:crypto";
import type { AppInfo, AttestationEvidence, EventLogEntry } from "./attestation";

/** Test support: quotes and event logs built to the documented TDX v4 layout. Not a real quote. */
export const sha = (alg: string, b: Buffer | string) => createHash(alg).update(b).digest();
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

export function fixture(over: { appCompose?: string; nonce?: string } = {}) {
  const appCompose = over.appCompose ?? compose();
  const nonce = over.nonce ?? "11".repeat(32);
  const events: EventLogEntry[] = [
    { imr: 0, event_type: 1, digest: "00".repeat(48), event: "boot", event_payload: "" }, // another register: must not affect RTMR3
    { imr: 3, event_type: 134217729, digest: sha("sha384", "app-id").toString("hex"), event: "app-id", event_payload: "abcd" },
    { imr: 3, event_type: 134217729, digest: sha("sha384", "compose-hash").toString("hex"), event: "compose-hash", event_payload: sha("sha256", appCompose).toString("hex") },
    { imr: 3, event_type: 134217729, digest: sha("sha384", "instance-id").toString("hex"), event: "instance-id", event_payload: "ff" },
  ];
  let rtmr = Buffer.alloc(48);
  for (const e of events) if (e.imr === 3) rtmr = sha("sha384", Buffer.concat([rtmr, Buffer.from(e.digest, "hex")]));
  const reportData = Buffer.alloc(64);
  Buffer.from(nonce, "hex").copy(reportData);
  const evidence: AttestationEvidence = { quote: buildQuote({ rtmr3: rtmr, reportData }), eventLog: JSON.stringify(events) };
  const info: AppInfo = { appCompose };
  return { nonce, evidence, info, events, rtmr };
}

