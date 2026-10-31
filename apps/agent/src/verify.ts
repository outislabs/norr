/**
 * Verify that a NEAR AI Cloud completion was produced inside an attested TEE, instead of taking the
 * "private model" label on trust. Follows NEAR AI's verification docs (docs.near.ai/cloud/verification):
 *
 *  1. Before the completion, fetch an attestation report with a fresh nonce and check each report that could
 *     have served it: the TDX quote is genuine (Phala's verifier, optional), not in debug mode, its report data
 *     binds the signer's key and our nonce, MRCONFIGID commits to the app configuration, the RTMR3 event log
 *     replays to the quote, and (model reports) NVIDIA's service accepts the GPU evidence.
 *  2. After the completion, fetch its signature and check the signed text is built from the exact bytes we sent
 *     and received, the signature recovers to the signer's address, and that signer is one a verified report vouched for.
 *
 * What it proves: that key signed these bytes, and the key lives in hardware running the measured configuration.
 * What it does not: which code is in that configuration (allowlist its compose hash if that matters), or that a
 * different instance of the same model did not answer (instances of a model share one signing key).
 */
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, parseQuote, verifyQuoteWithPhala, type Check } from "@norr/shared";
import type { Exchange } from "./llm";
import type { FetchLike } from "./llm";

const BASE = "https://cloud-api.near.ai/v1";
const NRAS = "https://nras.attestation.nvidia.com/v3/attest/gpu";

const pass = (id: string, label: string, detail: string): VCheck => ({ id, label, status: "pass", detail });
const fail = (id: string, label: string, detail: string): VCheck => ({ id, label, status: "fail", detail });
const skip = (id: string, label: string, detail: string): VCheck => ({ id, label, status: "skipped", detail });

export interface VCheck extends Omit<Check, "id"> {
  id: string;
}

interface Report {
  signing_address: string;
  signing_algo: string;
  intel_quote: string;
  event_log: unknown;
  request_nonce: string;
  nvidia_payload?: string;
  info?: { tcb_info?: unknown };
  model_name?: string;
}

interface SignatureBody {
  text?: string;
  signature?: string;
  signing_address?: string;
  signing_algo?: string;
  signature_kind?: string;
  error_code?: unknown;
}

interface Signer {
  kind: "gateway" | "provider_tee";
  algo: string;
  address: string;
}

const sha = (alg: "sha256" | "sha384", ...parts: Uint8Array[]): Uint8Array => {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const json = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
const le32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const clean = (h: string): string => h.replace(/^0x/i, "").toLowerCase();

/** The Ethereum address (lowercase hex, no prefix) that signed `message` with an EIP-191 personal signature. */
export function recoverSigner(message: string, signatureHex: string): string {
  const sig = hexToBytes(signatureHex);
  if (sig.length !== 65) throw new Error("signature is not 65 bytes");
  const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
  const body = text(message);
  const digest = keccak_256(concat(text(`\x19Ethereum Signed Message:\n${body.length}`), body));
  const pub = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
  return bytesToHex(keccak_256(pub.subarray(1)).subarray(12));
}

const concat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

/** RTMR3 from the event log the way NEAR AI's report defines it; each event's own digest must match too. */
export function replayEventLog(eventLog: unknown): string {
  let rtmr: Uint8Array = new Uint8Array(48);
  for (const e of json<{ imr: number; event_type: number; event: string; event_payload?: string; digest?: string }[]>(eventLog)) {
    if (e.imr !== 3) continue;
    const digest = sha("sha384", le32(e.event_type), text(":"), text(e.event), text(":"), hexToBytes(e.event_payload ?? ""));
    if (e.digest && !eq(hexToBytes(e.digest), digest)) throw new Error(`digest mismatch for event ${e.event}`);
    rtmr = sha("sha384", rtmr, digest);
  }
  return bytesToHex(rtmr);
}

export interface AttestorOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Ask Phala's service to verify each quote's signature chain (sends the quote there). Default true. */
  verifyQuoteChain?: boolean;
  /** Ask NVIDIA's service to verify GPU evidence. Default true. */
  verifyGpu?: boolean;
  /** Compose hashes (hex) the caller accepts; anything else fails. Unset means the hash is reported, not enforced. */
  allowedComposeHashes?: string[];
}

export interface CompletionVerdict {
  id: string;
  /** "attested" only when every check passed; "unverified" otherwise, with the reasons in `checks`. */
  status: "attested" | "unverified";
  kind?: string;
  checks: VCheck[];
}

export class Attestor {
  private readonly base: string;
  private readonly f: FetchLike;
  private readonly signers = new Map<string, { signers: Signer[]; checks: VCheck[] }>();

  constructor(private readonly o: AttestorOptions) {
    this.base = (o.baseUrl ?? BASE).replace(/\/+$/, "");
    this.f = o.fetch ?? ((url, init) => fetch(url, init));
  }

  private get headers(): Record<string, string> {
    return { authorization: `Bearer ${this.o.apiKey}`, accept: "application/json", "x-no-aliasing": "true", "user-agent": "norr-agent/0.1" };
  }

  /** One report: every check, never throws. */
  private async checkReport(label: string, r: Report, nonce: string, withGpu: boolean): Promise<VCheck[]> {
    const checks: VCheck[] = [];
    const id = (s: string) => `${label}:${s}`;
    try {
      const q = parseQuote(r.intel_quote);
      const identity = hexToBytes(clean(r.signing_address));
      if (!({ ecdsa: 20, ed25519: 32 } as Record<string, number>)[r.signing_algo] || identity.length !== ({ ecdsa: 20, ed25519: 32 } as Record<string, number>)[r.signing_algo]) throw new Error("unsupported signing identity");
      if (clean(r.request_nonce) !== nonce) throw new Error("report does not echo our nonce");
      const bound = concat(identity, new Uint8Array(32 - identity.length), hexToBytes(nonce));
      checks.push(eq(hexToBytes(q.reportData), bound) ? pass(id("binding"), `${label}: quote binds the signer and our nonce`, `Report data = signer ${r.signing_address.slice(0, 10)}… + our fresh nonce.`) : fail(id("binding"), `${label}: quote binds the signer and our nonce`, "The quote's report data is not this signer plus our nonce."));
      checks.push((hexToBytes(q.tdAttributes)[0]! & 1) === 0 ? pass(id("debug"), `${label}: not in debug mode`, "TDX debug bit is clear.") : fail(id("debug"), `${label}: not in debug mode`, "TDX debug mode is on: the enclave's memory is readable."));

      const tcb = json<{ app_compose?: string }>(r.info?.tcb_info);
      const appCompose = tcb.app_compose;
      if (typeof appCompose !== "string") throw new Error("report has no app_compose");
      const composeHash = bytesToHex(sha("sha256", text(appCompose)));
      const expected = concat(new Uint8Array([1]), hexToBytes(composeHash), new Uint8Array(15));
      let cfg = eq(hexToBytes(q.mrConfigId), expected);
      const allowed = this.o.allowedComposeHashes;
      const ok = cfg && (!allowed || allowed.includes(composeHash));
      checks.push(ok ? pass(id("config"), `${label}: configuration is the measured one`, `MRCONFIGID commits to app_compose ${composeHash.slice(0, 16)}…${allowed ? " (on the allowlist)" : " (not allowlisted: reported only)"}.`) : fail(id("config"), `${label}: configuration is the measured one`, cfg ? `app_compose ${composeHash.slice(0, 16)}… is not on the allowlist.` : "MRCONFIGID does not commit to this app_compose."));

      checks.push(replayEventLog(r.event_log) === q.rtmr3 ? pass(id("eventlog"), `${label}: event log matches the hardware measurement`, "Replaying the RTMR3 events reproduces the quote's RTMR3.") : fail(id("eventlog"), `${label}: event log matches the hardware measurement`, "Replaying the event log does not reproduce the quote's RTMR3."));
    } catch (e) {
      checks.push(fail(id("report"), `${label}: report is well formed`, e instanceof Error ? e.message : "unreadable"));
    }

    if (this.o.verifyQuoteChain === false) checks.push(skip(id("chain"), `${label}: quote signature chain`, "Disabled."));
    else {
      const c = await verifyQuoteWithPhala(r.intel_quote, this.f as typeof fetch);
      checks.push({ ...c, id: id("chain"), label: `${label}: ${c.label.toLowerCase()}` });
    }

    if (withGpu) {
      if (this.o.verifyGpu === false || !r.nvidia_payload) checks.push(skip(id("gpu"), `${label}: GPU evidence`, r.nvidia_payload ? "Disabled." : "No GPU payload in the report."));
      else checks.push(await this.checkGpu(label, r.nvidia_payload, nonce));
    }
    return checks;
  }

  private async checkGpu(label: string, payload: string, nonce: string): Promise<VCheck> {
    const name = `${label}: GPU evidence`;
    try {
      const body = json<{ nonce?: string }>(payload);
      if (typeof body.nonce !== "string" || body.nonce.toLowerCase() !== nonce) return fail(`${label}:gpu`, name, "GPU payload does not carry our nonce.");
      const res = await this.f(NRAS, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return skip(`${label}:gpu`, name, `NVIDIA's service answered ${res.status}.`);
      const arr = (await res.json()) as [string, string][];
      const jwt = arr.find((x) => x[0] === "JWT")?.[1];
      if (!jwt) return fail(`${label}:gpu`, name, "NVIDIA's answer has no token.");
      const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
      return claims["x-nvidia-overall-att-result"] === true ? pass(`${label}:gpu`, name, "NVIDIA's attestation service accepts the GPU evidence.") : fail(`${label}:gpu`, name, "NVIDIA's attestation service rejected the GPU evidence.");
    } catch {
      return skip(`${label}:gpu`, name, "Could not reach NVIDIA's attestation service.");
    }
  }

  /** Fetch and verify the evidence for a model, before any completion. Cached per model. */
  async preflight(model: string): Promise<{ signers: Signer[]; checks: VCheck[] }> {
    const hit = this.signers.get(model);
    if (hit) return hit;
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const url = `${this.base}/attestation/report?${new URLSearchParams({ model, provider: "near", signing_algo: "ecdsa", include_tls_fingerprint: "false", nonce })}`;
    const out: { signers: Signer[]; checks: VCheck[] } = { signers: [], checks: [] };
    try {
      const res = await this.f(url, { headers: this.headers, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`attestation report: HTTP ${res.status}`);
      const body = (await res.json()) as { gateway_attestation?: Report; model_attestations?: Report[] };
      if (body.gateway_attestation) {
        const cs = await this.checkReport("gateway", body.gateway_attestation, nonce, false);
        out.checks.push(...cs);
        if (cs.every((c) => c.status !== "fail")) out.signers.push({ kind: "gateway", algo: body.gateway_attestation.signing_algo, address: clean(body.gateway_attestation.signing_address) });
      }
      const models = body.model_attestations ?? [];
      if (models.length === 0) out.checks.push(fail("model:present", "model: evidence returned", "No model attestation was returned."));
      for (const [i, m] of models.entries()) {
        const cs = await this.checkReport(`model${models.length > 1 ? i + 1 : ""}`, m, nonce, true);
        out.checks.push(...cs);
        if (cs.every((c) => c.status !== "fail")) out.signers.push({ kind: "provider_tee", algo: m.signing_algo, address: clean(m.signing_address) });
      }
    } catch (e) {
      out.checks.push(fail("preflight", "attestation report fetched", e instanceof Error ? e.message : "failed"));
    }
    this.signers.set(model, out);
    return out;
  }

  /** Check one completion's signature against the verified signers. Never throws. */
  async verifyCompletion(id: string, x: Exchange): Promise<CompletionVerdict> {
    const pre = await this.preflight(x.model);
    const checks: VCheck[] = [...pre.checks];
    let kind: string | undefined;
    try {
      let sig: SignatureBody | null = null;
      for (let i = 0; i < 4 && !sig; i++) {
        const res = await this.f(`${this.base}/signature/${encodeURIComponent(id)}?signing_algo=ecdsa`, { headers: this.headers, signal: AbortSignal.timeout(30_000) });
        if (res.status === 404) {
          await new Promise((r) => setTimeout(r, 500 * (i + 1)));
          continue;
        }
        if (!res.ok) throw new Error(`signature: HTTP ${res.status}`);
        const b = (await res.json()) as SignatureBody;
        if (b?.error_code !== undefined || !b?.signature) throw new Error("no signature available for this completion");
        sig = b;
      }
      if (!sig) throw new Error("no signature found (404)");
      kind = sig.signature_kind ?? "provider_tee";
      if (kind !== "provider_tee" && kind !== "gateway") throw new Error(`unknown signature kind "${kind}"`);
      const expected = kind === "gateway" ? `${x.requestHash}:${x.responseHash}` : `${x.model}:${x.requestHash}:${x.responseHash}`;
      if (sig.text !== expected) throw new Error("signed text does not match the exact request and response bytes");
      checks.push(pass("text", "signature covers our exact request and response", "The signed text is built from the SHA-256 of the bytes we sent and received."));
      if (sig.signing_algo !== "ecdsa") throw new Error(`unsupported signing algorithm ${sig.signing_algo}`);
      const recovered = recoverSigner(sig.text, sig.signature!);
      if (recovered !== clean(sig.signing_address ?? "")) throw new Error("signature does not recover to the stated signer");
      checks.push(pass("signature", "signature is valid", `Recovers to ${recovered.slice(0, 10)}….`));
      const vouched = pre.signers.some((s) => s.kind === kind && s.algo === "ecdsa" && s.address === recovered);
      checks.push(vouched ? pass("signer", "signer is vouched for by verified hardware evidence", `Matches the ${kind === "gateway" ? "gateway" : "model"} report's key, which passed every check above.`) : fail("signer", "signer is vouched for by verified hardware evidence", "No verified report carries this signing key."));
    } catch (e) {
      checks.push(fail("signature", "signature verified", e instanceof Error ? e.message : "failed"));
    }
    return { id, status: checks.every((c) => c.status !== "fail") && checks.some((c) => c.id === "signer" && c.status === "pass") ? "attested" : "unverified", ...(kind ? { kind } : {}), checks };
  }
}

/** One line per completion for the CLI and the eval table. */
export const summarize = (vs: CompletionVerdict[]): string => {
  const ok = vs.filter((v) => v.status === "attested").length;
  const skipped = new Set(vs.flatMap((v) => v.checks.filter((c) => c.status === "skipped").map((c) => c.label)));
  return `${ok}/${vs.length} completions attested${skipped.size ? ` (skipped: ${[...skipped].join("; ")})` : ""}`;
};
