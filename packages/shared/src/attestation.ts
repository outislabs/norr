/**
 * Checks anyone can repeat on a Norr service's attestation: in the dashboard's Verify screen, in
 * `scripts/verify-attestation.mts`, or by hand. Pure apart from WebCrypto hashing, so the same code runs in
 * a browser and in Node. Follows Phala's "Verify Your Application" guide:
 *
 *  1. the quote's report data starts with the nonce we sent (the quote is fresh, not replayed);
 *  2. the SHA-256 of the app-compose configuration equals the `compose-hash` event in the event log;
 *  3. replaying the RTMR3 events reproduces the RTMR3 inside the quote (the event log is the one the hardware measured);
 *  4. every container image in the compose file is pinned by digest, not by a mutable tag.
 *
 * What these checks do NOT do: verify the quote's signature chain back to Intel. That is a separate check
 * (Phala's verification API, or `dcap-qvl` locally); see `verifyQuoteWithPhala`. Until it passes, checks 1 to 4
 * show the pieces are consistent with each other, not that a genuine TEE produced them.
 *
 * The quote layout is the documented TDX quote v4: a 48-byte header, then the TD report body in which RTMR3
 * and REPORTDATA sit at fixed offsets. Not yet exercised against a real quote; tests use quotes built to that layout.
 */

export interface EventLogEntry {
  imr: number;
  event_type?: number;
  digest: string;
  event: string;
  event_payload: string;
}

export interface AttestationEvidence {
  /** The TDX quote, hex. */
  quote: string;
  /** The event log, a JSON string. */
  eventLog: string;
  vmConfig?: string;
  /** The report data the service says it put in the quote, hex. */
  reportData?: string;
}

export interface AppInfo {
  appId?: string;
  instanceId?: string;
  composeHash?: string;
  /** The app-compose configuration exactly as the platform measured it (a JSON string). */
  appCompose: string;
  osImageHash?: string;
  commit?: string | null;
}

export interface ParsedQuote {
  version: number;
  teeType: number;
  mrtd: string;
  /** MRCONFIGID: the platform's commitment to the app configuration (NEAR AI Cloud binds SHA-256 of app_compose here). */
  mrConfigId: string;
  /** TDATTRIBUTES; bit 0 of the first byte is TDX debug mode. */
  tdAttributes: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  rtmr3: string;
  /** 64 bytes, hex. */
  reportData: string;
}

export type CheckStatus = "pass" | "fail" | "skipped";
export interface Check {
  id: "quote-format" | "fresh" | "compose-hash" | "event-log" | "images-pinned" | "quote-signature";
  label: string;
  status: CheckStatus;
  detail: string;
}

const HEADER = 48;
const BODY_RTMR3 = 472;
const BODY_REPORT_DATA = 520;
const QUOTE_MIN = HEADER + BODY_REPORT_DATA + 64;

const subtle = () => globalThis.crypto.subtle;

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.trim().replace(/^0x/i, "");
  if (h.length % 2 !== 0 || /[^0-9a-f]/i.test(h)) throw new Error("not valid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const digest = async (alg: "SHA-256" | "SHA-384", data: Uint8Array): Promise<Uint8Array> => new Uint8Array(await subtle().digest(alg, data as unknown as BufferSource));

/** Read the fields we check out of a TDX v4 quote. Throws on anything that is not one. */
export function parseQuote(quoteHex: string): ParsedQuote {
  const q = hexToBytes(quoteHex);
  if (q.length < QUOTE_MIN) throw new Error(`quote is ${q.length} bytes, too short for a TDX quote`);
  const view = new DataView(q.buffer, q.byteOffset, q.byteLength);
  const version = view.getUint16(0, true);
  const teeType = view.getUint32(4, true);
  if (version !== 4) throw new Error(`quote version ${version}, expected 4`);
  if (teeType !== 0x81) throw new Error(`TEE type 0x${teeType.toString(16)}, expected 0x81 (TDX)`);
  const field = (off: number, len: number) => bytesToHex(q.subarray(HEADER + off, HEADER + off + len));
  return {
    version,
    teeType,
    mrtd: field(136, 48),
    mrConfigId: field(184, 48),
    tdAttributes: field(120, 8),
    rtmr0: field(328, 48),
    rtmr1: field(376, 48),
    rtmr2: field(424, 48),
    rtmr3: field(BODY_RTMR3, 48),
    reportData: field(BODY_REPORT_DATA, 64),
  };
}

export function parseEventLog(eventLog: string): EventLogEntry[] {
  const parsed: unknown = JSON.parse(eventLog);
  if (!Array.isArray(parsed)) throw new Error("event log is not a list");
  return parsed.map((e) => {
    const o = e as Partial<EventLogEntry>;
    if (typeof o.imr !== "number" || typeof o.digest !== "string" || typeof o.event !== "string" || typeof o.event_payload !== "string") throw new Error("event log entry is malformed");
    return o as EventLogEntry;
  });
}

/** RTMR3 as the platform extends it: start from 48 zero bytes, then SHA-384(rtmr || digest) for each IMR 3 event. */
export async function replayRtmr3(events: EventLogEntry[]): Promise<string> {
  let rtmr: Uint8Array = new Uint8Array(48);
  for (const e of events) {
    if (e.imr !== 3) continue;
    const d = hexToBytes(e.digest);
    const padded = new Uint8Array(48);
    padded.set(d.subarray(0, 48)); // shorter digests are zero-padded, as in the TCG event-log rules
    rtmr = await digest("SHA-384", concat(rtmr, padded));
  }
  return bytesToHex(rtmr);
}

/** The images a compose file runs, and whether each is pinned by digest. */
export function composeImages(appCompose: string): { image: string; pinned: boolean }[] {
  const cfg = JSON.parse(appCompose) as { docker_compose_file?: unknown };
  if (typeof cfg.docker_compose_file !== "string") throw new Error("app-compose has no docker_compose_file");
  const images: { image: string; pinned: boolean }[] = [];
  for (const line of cfg.docker_compose_file.split("\n")) {
    const m = /^\s*image:\s*["']?([^\s"'#]+)/.exec(line);
    if (m) images.push({ image: m[1]!, pinned: /@sha256:[0-9a-f]{64}$/i.test(m[1]!) });
  }
  return images;
}

const result = (id: Check["id"], label: string, status: CheckStatus, detail: string): Check => ({ id, label, status, detail });

/**
 * Run checks 1 to 4 on what a service returned for `nonceHex`. Never throws: anything unparseable is a failed
 * check with the reason, so a damaged or hostile response cannot read as success.
 */
export async function checkAttestation(nonceHex: string, evidence: AttestationEvidence, info: AppInfo): Promise<Check[]> {
  const checks: Check[] = [];
  let quote: ParsedQuote | null = null;
  try {
    quote = parseQuote(evidence.quote);
    checks.push(result("quote-format", "The quote is a TDX quote", "pass", `TDX quote v${quote.version}; measurement MRTD ${quote.mrtd.slice(0, 16)}…`));
  } catch (e) {
    checks.push(result("quote-format", "The quote is a TDX quote", "fail", e instanceof Error ? e.message : "unreadable"));
  }

  try {
    const nonce = hexToBytes(nonceHex);
    if (!quote) throw new Error("no readable quote");
    const rd = quote.reportData;
    const ok = nonce.length > 0 && nonce.length <= 64 && rd.startsWith(bytesToHex(nonce)) && /^0*$/.test(rd.slice(nonce.length * 2));
    checks.push(result("fresh", "The quote answers the nonce we just sent", ok ? "pass" : "fail", ok ? "Its report data is our nonce (padded with zeros): this quote was made for this request." : "Its report data is not our nonce: the quote may be a replay."));
  } catch (e) {
    checks.push(result("fresh", "The quote answers the nonce we just sent", "fail", e instanceof Error ? e.message : "unreadable"));
  }

  let events: EventLogEntry[] | null = null;
  try {
    events = parseEventLog(evidence.eventLog);
  } catch (e) {
    events = null;
    checks.push(result("compose-hash", "The configuration is the one that was measured", "fail", `event log: ${e instanceof Error ? e.message : "unreadable"}`));
  }

  if (events) {
    try {
      const claimed = events.find((e) => e.event === "compose-hash")?.event_payload.toLowerCase();
      const actual = bytesToHex(await digest("SHA-256", new TextEncoder().encode(info.appCompose)));
      const ok = claimed !== undefined && claimed === actual;
      checks.push(result("compose-hash", "The configuration is the one that was measured", ok ? "pass" : "fail", ok ? `SHA-256 of the app configuration equals the compose-hash event (${actual.slice(0, 16)}…).` : claimed === undefined ? "The event log has no compose-hash event." : "The app configuration does not hash to the compose-hash event: it is not what the platform measured."));
    } catch (e) {
      checks.push(result("compose-hash", "The configuration is the one that was measured", "fail", e instanceof Error ? e.message : "unreadable"));
    }

    try {
      if (!quote) throw new Error("no readable quote");
      const replayed = await replayRtmr3(events);
      const ok = replayed === quote.rtmr3;
      checks.push(result("event-log", "The event log is the one the hardware measured", ok ? "pass" : "fail", ok ? "Replaying the RTMR3 events reproduces the RTMR3 in the quote." : "Replaying the events does not reproduce the quote's RTMR3: the log was altered or is for another machine."));
    } catch (e) {
      checks.push(result("event-log", "The event log is the one the hardware measured", "fail", e instanceof Error ? e.message : "unreadable"));
    }
  }

  try {
    const images = composeImages(info.appCompose);
    const loose = images.filter((i) => !i.pinned).map((i) => i.image);
    const ok = images.length > 0 && loose.length === 0;
    checks.push(result("images-pinned", "Every image is pinned by digest", ok ? "pass" : "fail", images.length === 0 ? "No images found in the configuration." : ok ? images.map((i) => i.image).join("\n") : `Not pinned by digest: ${loose.join(", ")}. A tag can be repointed to different code.`));
  } catch (e) {
    checks.push(result("images-pinned", "Every image is pinned by digest", "fail", e instanceof Error ? e.message : "unreadable"));
  }

  return checks;
}

/**
 * Ask Phala's verification service whether the quote's signature chain is genuine. This sends the quote to
 * Phala (and trusts its answer); `dcap-qvl verify --quote-hex ...` does the same check locally.
 */
export async function verifyQuoteWithPhala(quoteHex: string, fetchImpl: typeof fetch = fetch): Promise<Check> {
  const label = "The quote's signature chain is genuine";
  try {
    const res = await fetchImpl("https://cloud-api.phala.network/api/v1/attestations/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hex: quoteHex.replace(/^0x/i, "") }) });
    if (!res.ok) return result("quote-signature", label, "skipped", `Phala's verification service answered ${res.status}. Verify locally with dcap-qvl.`);
    const body = (await res.json()) as { success?: boolean; quote?: { verified?: boolean } };
    return body.quote?.verified === true
      ? result("quote-signature", label, "pass", "Phala's verification service confirms the quote verifies against Intel's certificate chain.")
      : result("quote-signature", label, "fail", "Phala's verification service did not verify the quote.");
  } catch {
    return result("quote-signature", label, "skipped", "Could not reach Phala's verification service. Verify locally with dcap-qvl.");
  }
}

/** True only when every check passed (a skipped check is not a pass). */
export const allPass = (checks: Check[]): boolean => checks.length > 0 && checks.every((c) => c.status === "pass");
