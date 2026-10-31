// Read-only: does this OutLayer wallet's policy let swaps run without approval while withdrawals stay gated?
// It reads the policy and asks the gateway's dry-run endpoints; no operation is executed and no funds can move.
//   pnpm exec tsx scripts/autonomy-check.mts
try {
  process.loadEnvFile(".env");
} catch {
  /* real environment */
}
const demo = process.env.NORR_WALLET === "demo" || process.argv.includes("--demo");
const key = (demo ? process.env.OUTLAYER_DEMO_API_KEY : process.env.OUTLAYER_API_KEY) ?? "";
const owner = process.env.NORR_OWNER_ACCOUNT ?? "";
const base = (process.env.OUTLAYER_BASE_URL ?? "https://api.outlayer.ai").replace(/\/+$/, "");
if (!key || !owner) throw new Error("Needs the wallet API key and NORR_OWNER_ACCOUNT in .env (--demo uses the OUTLAYER_DEMO_* key).");

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, json };
};

const pol = await call("GET", "/wallet/v1/policy");
const p = pol.json as Record<string, any>;
console.log("policy (read):", pol.status, p?.frozen ? "FROZEN" : "not frozen");
console.log("  approval threshold:", p?.approval?.threshold?.required ?? "none", "| approvers:", (p?.approval?.approvers ?? []).map((a: any) => a.id).join(", ") || "none");
console.log("  approval.excluded_types:", JSON.stringify(p?.approval?.excluded_types ?? "none (every operation waits for approval)"));
console.log("  allowed transaction_types:", JSON.stringify(p?.rules?.transaction_types ?? "unrestricted"));
console.log("  address whitelist:", JSON.stringify(p?.rules?.addresses?.mode), (p?.rules?.addresses?.list ?? []).map((x: string) => (x.length > 30 ? `${x.slice(0, 8)}…` : x)).join(", "));
console.log("  capabilities:", Object.entries(p?.capabilities ?? {}).map(([k, v]: [string, any]) => `${k}=${v?.allowed}${v?.requires_approval !== undefined ? `(approval:${v.requires_approval})` : ""}`).join(" "));

const show = (label: string, r: { status: number; json: any }) => {
  const j = r.json ?? {};
  const msg = [j.message, j.error, j.detail, j.reason].filter((x) => typeof x === "string").join(" | ");
  console.log(`${label}: HTTP ${r.status}; would_succeed=${j.would_succeed ?? "?"}; requires_approval/msg: ${msg || JSON.stringify(j).slice(0, 220)}`);
};
// There is no swap dry-run route (both answer 404), so whether a swap needs approval is only visible by running one.
show("public withdraw dry-run   ", await call("POST", "/wallet/v1/intents/withdraw/dry-run", { to: owner, amount: "1000000", token: USDC, chain: "near" }));
show("confidential withdraw dry-run", await call("POST", "/wallet/v1/confidential/withdraw/dry-run", { to: owner, amount: "1000000", token: USDC, chain: "near" }));
