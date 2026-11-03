import type { Check } from "@norr/shared";

/**
 * The quote's signature chain, checked in this browser with Phala's dcap-qvl compiled to WebAssembly.
 *
 * What is trusted: Intel's SGX root CA, which is built into the dcap-qvl binary. The collateral (TCB info, QE
 * identity, CRLs) is fetched from Phala's PCCS because it is the one certificate cache that allows browsers (CORS);
 * every piece of it is signed by Intel and checked against that root here. A dishonest or broken PCCS can make the
 * check fail or be skipped, but cannot make a forged quote pass. The quote itself is not sent anywhere: the PCCS
 * only learns the platform's FMSPC (a CPU family identifier) from the TCB-info request.
 */
export const PCCS_URL = "https://pccs.phala.network/sgx/certification/v4/";
const LABEL = "The quote's signature chain is genuine";

export interface QvlResult {
  status: string;
  advisory_ids?: string[];
}
export interface Qvl {
  getCollateral(pccsUrl: string, quote: Uint8Array): Promise<unknown>;
  verify(quote: Uint8Array, collateral: unknown, now: bigint): QvlResult;
}

/** Loads the WebAssembly verifier on demand (about 1 MB), from this site. */
export async function loadQvl(): Promise<Qvl> {
  const [m, { default: wasmUrl }] = await Promise.all([import("@phala/dcap-qvl-web"), import("@phala/dcap-qvl-web/dcap-qvl-web_bg.wasm?url")]);
  await m.default({ module_or_path: wasmUrl });
  return { getCollateral: (u, q) => m.js_get_collateral(u, q) as Promise<unknown>, verify: (q, c, now) => m.js_verify(q, c, now) as QvlResult };
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, "");
  if (h.length % 2 !== 0 || /[^0-9a-f]/i.test(h)) throw new Error("The quote is not hex.");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Pure mapping from the verifier's answer to a check; kept apart so every branch is testable. */
export function signatureCheck(r: QvlResult): Check {
  const advisories = r.advisory_ids?.length ? ` Intel advisories that apply: ${r.advisory_ids.join(", ")}.` : "";
  if (r.status === "Revoked") return { id: "quote-signature", label: LABEL, status: "fail", detail: "Intel has revoked this platform's certificate (TCB status Revoked)." };
  if (r.status === "UpToDate") return { id: "quote-signature", label: LABEL, status: "pass", detail: "Verified in this browser against Intel's root certificate. The platform's TCB is up to date." };
  return { id: "quote-signature", label: LABEL, status: "pass", detail: `Verified in this browser against Intel's root certificate. The platform's TCB status is ${r.status}, so Intel recommends updates for it.${advisories}` };
}

/** Fetch the collateral and verify the quote. Never throws: an unreachable PCCS is "skipped", a bad quote is "fail". */
export async function verifyQuoteSignature(quoteHex: string, qvl: Qvl, nowMs: number = Date.now()): Promise<Check> {
  let quote: Uint8Array;
  try {
    quote = hexToBytes(quoteHex);
  } catch (e) {
    return { id: "quote-signature", label: LABEL, status: "fail", detail: e instanceof Error ? e.message : "Unreadable quote." };
  }
  let collateral: unknown;
  try {
    collateral = await qvl.getCollateral(PCCS_URL, quote);
  } catch {
    return { id: "quote-signature", label: LABEL, status: "skipped", detail: "Could not fetch Intel's certificate data from Phala's PCCS, so the signature was not checked. Copy the quote into the explorer below, or try again." };
  }
  try {
    return signatureCheck(qvl.verify(quote, collateral, BigInt(Math.floor(nowMs / 1000))));
  } catch (e) {
    return { id: "quote-signature", label: LABEL, status: "fail", detail: `The quote does not verify against Intel's certificates: ${e instanceof Error ? e.message : String(e)}.` };
  }
}
