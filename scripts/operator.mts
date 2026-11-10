// Operator overview: aggregates only (counts, totals, rates, health, alerts), read from the running service.
//   NORR_ADMIN_TOKEN=... pnpm exec tsx scripts/operator.mts [https://api.norr.finance] [--json]
// The admin token is read from the environment (never an argument, so it stays out of shell history) and is not printed.
const base = process.argv.slice(2).find((a) => a.startsWith("http")) ?? "https://api.norr.finance";
const token = process.env.NORR_ADMIN_TOKEN;
if (!token) {
  console.error("Set NORR_ADMIN_TOKEN (the same value as in deploy/.env.phala).");
  process.exit(2);
}
const r = await fetch(`${base.replace(/\/+$/, "")}/admin/v1/overview`, { headers: { "x-admin-token": token } });
if (!r.ok) {
  console.error(`The service answered ${r.status}${r.status === 401 ? " (wrong token)" : r.status === 404 ? " (this build has no overview yet: redeploy)" : ""}.`);
  process.exit(1);
}
const o = (await r.json()) as any;
if (process.argv.includes("--json")) console.log(JSON.stringify(o, null, 2));
else {
  const reach = (x: any) => (x === "mock" ? "mock" : x.ok ? `ok (${x.ms} ms)` : `DOWN (${x.status ?? "no answer"})`);
  const sum = (k: string) => o.last24Hours.perHour.reduce((s: number, h: any) => s + h[k], 0);
  console.log(`Norr operator overview, ${o.at}\n  ${o.note}\n`);
  console.log(`Signups     ${o.signups.open ? "open" : "CLOSED"}; created today ${o.signups.createdToday}, last 7 days ${o.signups.createdLast7Days}`);
  console.log(`Vaults      ${o.vaults.total} of ${o.vaults.limit} (${o.vaults.active} active, ${o.vaults.inSetup} in setup; ${o.vaults.pausedOfRunning} of ${o.vaults.runningVaults} running are paused)`);
  console.log(`Deposits    $${o.deposits.totalValueUsd} held; cap $${o.deposits.capPerVaultUsd} per vault, ceiling $${o.deposits.ceilingUsd}; near cap ${o.deposits.vaultsNearCap}, over cap ${o.deposits.vaultsOverCap}, unreadable ${o.deposits.balancesUnreadable}`);
  console.log(`Health      1Click ${reach(o.health.oneClick)}; OutLayer ${reach(o.health.outLayer)}; pricing ${o.health.pricing}; incident feed ${o.health.incidentFeed}`);
  console.log(`Last 24 h   executed ${sum("executed")}, refused ${sum("blocked")}, failed ${sum("failed")}, refunded ${sum("refunded")}; server errors ${sum("s5xx")}, rate-limited ${sum("s429")}`);
  const codes = Object.entries(o.last24Hours.blockedByCode).map(([k, v]) => `${k} ${v}`).join(", ");
  if (codes) console.log(`            refusals by rule: ${codes}`);
  console.log(`\n${o.alerts.length === 0 ? "No alerts." : "ALERTS:"}`);
  for (const a of o.alerts) console.log(`  ${a.level === "alert" ? "ALERT" : "warn "}  ${a.code}: ${a.message}`);
  if (o.alerts.some((a: any) => a.level === "alert")) process.exitCode = 3;
}
