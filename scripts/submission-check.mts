// Validate the hackathon submission payload against the organizers' contract (https://nearhackathon.com/HACKATHON.md,
// "Submission API") and print it. It NEVER sends anything: sending is a separate, deliberate step (docs/SUBMISSION.md).
//   pnpm exec tsx scripts/submission-check.mts [path]        default path: config/submission.local.json (gitignored)
//   pnpm exec tsx scripts/submission-check.mts --online      also checks that the repository URL answers
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FIELDS = ["requestId", "projectName", "leadName", "email", "size", "tracks", "nearAddress", "projectUrl", "demoUrl", "idea", "consent"] as const;
const SIZES = ["1", "2 - 4", "4 - 6", "6 - 8", "8+"];
const TRACKS = ["defi", "thesis", "privacy", "business", "swarms", "security", "agents", "realworld", "games", "nfts", "memecoins", "social", "open"];
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WINDOW = { opens: Date.parse("2026-11-01T00:00:00Z"), closes: Date.parse("2026-11-14T23:59:00Z") };

/** Every problem with a payload, by the organizers' rules. Empty means it is valid. */
export function problems(p: Record<string, unknown>, now = Date.now()): string[] {
  const out: string[] = [];
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  const len = (k: string, min: number, max: number) => {
    const n = str(k).length;
    if (typeof p[k] !== "string" || n < min || n > max) out.push(`${k}: a string of ${min} to ${max} characters (now ${typeof p[k] === "string" ? n : "missing"})`);
  };
  for (const k of Object.keys(p)) if (!(FIELDS as readonly string[]).includes(k)) out.push(`${k}: not a field; send exactly the documented ones (website is a spam trap)`);
  for (const k of FIELDS) if (!(k in p)) out.push(`${k}: missing`);
  if (!UUID.test(str("requestId"))) out.push("requestId: a UUID, generated once with `uuidgen | tr A-Z a-z` and reused on retries");
  len("projectName", 2, 80);
  len("leadName", 2, 80);
  if (!EMAIL.test(str("email")) || str("email").length > 160) out.push("email: a valid address, at most 160 characters");
  if (!SIZES.includes(str("size"))) out.push(`size: exactly one of ${SIZES.map((s) => `"${s}"`).join(", ")}`);
  const tracks = p.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0 || tracks.some((t) => !TRACKS.includes(t as string)) || new Set(tracks).size !== tracks.length) out.push(`tracks: one or more of ${TRACKS.join(", ")}, each once`);
  const acct = str("nearAddress");
  if (acct.length < 2 || acct.length > 64 || !NEAR_ACCOUNT.test(acct)) out.push("nearAddress: 2 to 64 characters, lowercase, a NEAR account (for example team.near, or a 64-character implicit account)");
  for (const k of ["projectUrl", "demoUrl"]) {
    try {
      const u = new URL(str(k));
      if (!/^https?:$/.test(u.protocol) || str(k).length > 300) throw new Error();
    } catch {
      out.push(`${k}: an http(s) URL of at most 300 characters`);
    }
  }
  len("idea", 20, 2000);
  if (p.consent !== true) out.push("consent: true, only after the human agreed to the contact notice");
  if (Buffer.byteLength(JSON.stringify(p)) > 12000) out.push("the body is over 12000 bytes");
  if (now < WINDOW.opens || now > WINDOW.closes) out.push("the submission window is 2026-11-01 00:00 to 2026-11-14 23:59 UTC: the API answers 403 outside it");
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const online = args.includes("--online");
  const path = args.find((a) => !a.startsWith("--")) ?? "config/submission.local.json";
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    console.error(`Could not read ${path}: ${e instanceof Error ? e.message : e}\nCreate it with the fields in docs/SUBMISSION.md.`);
    process.exit(2);
  }
  // The payload holds personal data and must never be committed.
  try {
    execFileSync("git", ["check-ignore", "-q", path], { stdio: "ignore" });
  } catch {
    console.warn(`WARNING: ${path} is not gitignored. It holds personal data; keep it out of the repository.\n`);
  }
  const found = problems(payload);
  console.log(JSON.stringify(payload, null, 2));
  console.log(`\nidea: ${String(payload.idea ?? "").length} characters (20 to 2000) | body: ${Buffer.byteLength(JSON.stringify(payload))} bytes (up to 12000)`);
  if (online && typeof payload.projectUrl === "string") {
    const r = await fetch(payload.projectUrl, { redirect: "follow" }).catch(() => null);
    console.log(`projectUrl answers: ${r ? r.status : "no answer"} ${r?.ok ? "(public)" : "(not reachable: judges cannot open it)"}`);
  }
  if (found.length === 0) console.log("\nPASS: the payload meets the organizers' contract. Nothing was sent. Send it only after you have read it and confirmed.");
  else {
    console.log(`\nFAIL: ${found.length} problem${found.length === 1 ? "" : "s"}:`);
    for (const f of found) console.log(`  - ${f}`);
    process.exit(1);
  }
}
