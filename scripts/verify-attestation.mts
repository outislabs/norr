// Check a Norr service's attestation from a terminal, the same checks as the dashboard's Verify screen.
//   pnpm exec tsx scripts/verify-attestation.mts https://<service-url> [--no-phala]
// Exit code 0 only if every check passes; a check that could not run counts as not passed.
import { allPass, checkAttestation, composeImages, verifyQuoteWithPhala } from "../packages/shared/src/index";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "no-phala": { type: "boolean", default: false } } });
const base = positionals[0]?.replace(/\/+$/, "");
if (!base || !/^https?:\/\//.test(base)) {
  console.error("usage: verify-attestation.mts <service URL> [--no-phala]");
  process.exit(2);
}

const nonce = randomBytes(32).toString("hex");
const get = async (path: string) => {
  const res = await fetch(`${base}${path}`, { headers: { "user-agent": "norr-verify/0.1" } });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) throw new Error(`${path}: HTTP ${res.status}${body && typeof body.error === "string" ? ` (${body.error})` : ""}`);
  return body;
};

try {
  const [ev, info] = await Promise.all([get(`/attestation?nonce=${nonce}`), get("/info")]);
  const evidence = ev as unknown as Parameters<typeof checkAttestation>[1] & { commit?: string | null };
  const appInfo = info as unknown as Parameters<typeof checkAttestation>[2];
  const checks = await checkAttestation(nonce, evidence, appInfo);
  if (!values["no-phala"]) checks.push(await verifyQuoteWithPhala(evidence.quote));
  const mark = { pass: "PASS", fail: "FAIL", skipped: "SKIP" } as const;
  for (const c of checks) console.log(`${mark[c.status]}  ${c.label}\n      ${c.detail.split("\n").join("\n      ")}`);
  console.log(`\nservice        ${base}`);
  console.log(`git commit     ${evidence.commit ?? "not reported"}`);
  console.log(`compose hash   ${appInfo.composeHash ?? "not reported"}`);
  try {
    for (const i of composeImages(appInfo.appCompose)) console.log(`image          ${i.image}`);
  } catch {
    /* reported by the images check */
  }
  const ok = allPass(checks);
  console.log(ok ? "\nAll checks passed." : "\nNOT all checks passed (a skipped check does not count).");
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(`Could not verify: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
