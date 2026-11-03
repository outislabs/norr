/**
 * Is the TLS certificate this domain serves bound to Norr's attested CVM?
 *
 *   pnpm exec tsx scripts/verify-domain.mts <domain> <service URL>
 *   e.g. pnpm exec tsx scripts/verify-domain.mts mcp.norr.finance https://api.norr.finance
 *
 * dstack-ingress publishes evidence at https://<domain>/evidences/: the ACME account, each certificate, a
 * sha256sum.txt over them, and a TDX quote whose report data is sha256(sha256sum.txt). The checks:
 *   1. the evidence quote is a TDX quote, and its signature chain is genuine (Phala's verification API);
 *   2. its report data is the hash of sha256sum.txt, and sha256sum.txt matches the published files;
 *   3. the certificate this domain actually serves over TLS is the published one;
 *   4. the evidence quote comes from the same VM and configuration as a fresh, nonce-bound attestation of the
 *      service (same MRTD, RTMR0-3 and MRCONFIGID), which scripts/verify-attestation.mts checks in full;
 *   5. CAA: whether issuance for the domain is pinned to the CVM's ACME account (prints the record if not).
 */
import { parseQuote, verifyQuoteWithPhala, type AttestationEvidence } from "../packages/shared/src/attestation";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { resolveCaa } from "node:dns/promises";
import { connect } from "node:tls";

const [domain, service] = process.argv.slice(2);
if (!domain || !service) throw new Error("usage: tsx scripts/verify-domain.mts <domain> <service URL>");

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
let failed = 0;
const report = (ok: boolean | null, label: string, detail = "") => {
  if (ok === false) failed++;
  console.log(`${ok === null ? "INFO" : ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
};
// One connection per file: the ingress (HAProxy, L4) may close an idle keep-alive connection between requests.
const get = async (path: string, attempt = 1): Promise<Uint8Array> => {
  try {
    const r = await fetch(`https://${domain}/evidences/${path}`, { headers: { connection: "close" } });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    if (attempt < 3) return get(path, attempt + 1);
    throw e;
  }
};

// 1-2. The evidence and its quote.
const sums = await get("sha256sum.txt");
const quoteDoc = JSON.parse(new TextDecoder().decode(await get("quote.json"))) as { quote: string };
const q = parseQuote(quoteDoc.quote);
report(true, "the evidence quote is a TDX v4 quote", `MRTD ${q.mrtd.slice(0, 16)}…`);
const sig = await verifyQuoteWithPhala(quoteDoc.quote);
report(sig.status === "pass" ? true : sig.status === "fail" ? false : null, "the evidence quote's signature chain is genuine", sig.detail);
report(q.reportData === sha256(sums) + "0".repeat(64), "its report data is sha256(sha256sum.txt)", `sha256sum.txt ${sha256(sums).slice(0, 16)}…`);

const listed = new Map(new TextDecoder().decode(sums).trim().split("\n").map((l) => { const [h, f] = l.trim().split(/\s+/); return [f!, h!] as const; }));
const certName = `cert-${domain}.pem`;
const files: Record<string, Uint8Array> = {};
for (const f of ["acme-account.json", certName]) {
  files[f] = await get(f);
  report(listed.get(f) === sha256(files[f]!), `sha256sum.txt covers ${f}`, listed.has(f) ? "" : "not listed");
}

// 3. The certificate actually served over TLS, against the published one.
const pem = new TextDecoder().decode(files[certName]!);
const published = new X509Certificate(pem.slice(0, pem.indexOf("-----END CERTIFICATE-----") + 25));
const served = await new Promise<Buffer>((resolve, reject) => {
  const s = connect({ host: domain, port: 443, servername: domain }, () => { resolve(s.getPeerCertificate().raw); s.end(); });
  s.on("error", reject);
});
report(sha256(served) === sha256(published.raw), "the certificate served over TLS is the published one", `${published.subject.replace(/\n/g, " ")}, issued by ${published.issuer.split("\n").find((l) => l.startsWith("O=")) ?? published.issuer}, SHA-256 ${sha256(served).slice(0, 16)}…`);

// 4. Same VM and configuration as a fresh attestation of the service.
const nonce = randomBytes(32).toString("hex");
const ev = (await (await fetch(`${service.replace(/\/+$/, "")}/attestation?nonce=${nonce}`)).json()) as AttestationEvidence & { attested?: boolean };
if (!ev.attested) throw new Error("the service did not return an attestation");
const fresh = parseQuote(ev.quote);
const same = (["mrtd", "mrConfigId", "rtmr0", "rtmr1", "rtmr2", "rtmr3"] as const).filter((k) => fresh[k] !== q[k]);
report(fresh.reportData.startsWith(nonce) && same.length === 0, "the evidence comes from the same VM and configuration as a fresh attestation of the service", same.length ? `differs in ${same.join(", ")}` : `MRCONFIGID ${q.mrConfigId.slice(2, 18)}… (the compose hash), RTMR3 ${q.rtmr3.slice(0, 16)}…`);

// 5. CAA pinning.
const account = JSON.parse(new TextDecoder().decode(files["acme-account.json"]!)) as { uri?: string; registration?: { uri?: string; accountURL?: string } };
const accountUri = account.uri ?? account.registration?.uri ?? account.registration?.accountURL ?? "";
const caa = await resolveCaa(domain).catch(() => []);
const pinned = caa.some((r) => typeof r.issue === "string" && r.issue.includes("letsencrypt.org") && r.issue.includes(accountUri));
report(caa.length ? pinned : null, pinned ? "CAA pins issuance to the CVM's ACME account" : "CAA does not pin issuance yet", `record to add: ${domain} CAA 0 issue "letsencrypt.org;validationmethods=tls-alpn-01;accounturi=${accountUri}"`);

console.log(failed ? `\n${failed} check(s) failed.` : "\nThe certificate is bound to the attested CVM.");
process.exit(failed ? 1 : 0);
