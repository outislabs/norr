// Day-1 gating check: confirm Ondo equities are routable via 1Click. Read-only.
const base = process.env.ONECLICK_BASE_URL ?? "https://1click.chaindefuser.com";
const [all, withOndo] = await Promise.all(
  ["/v0/tokens", "/v0/tokens?ondoTokens=true"].map((p) => fetch(base + p).then((r) => r.json())),
);
const known = new Set(all.map((t) => t.assetId));
const ondo = withOndo.filter((t) => !known.has(t.assetId));
console.log(`public tokens: ${all.length}, extra Ondo tokens: ${ondo.length}`);
for (const t of ondo) console.log(t.symbol.padEnd(8), t.blockchain, t.assetId, t.price);
