// One manually driven live trade through the real Norr pipeline. Dry run unless --confirm-mainnet.
//   pnpm live:trade --side buy --asset NVDA --usd 30 [--reason "..."] [--confirm-mainnet]
import { runLiveTrade } from "../apps/enclave/src/live-runner";
import { buildLiveDeps } from "../apps/enclave/src/live";
import { parseArgs } from "node:util";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env: rely on the real environment */
}

const { values } = parseArgs({
  options: {
    side: { type: "string" },
    asset: { type: "string" },
    usd: { type: "string" },
    reason: { type: "string", default: "manual live test" },
    "confirm-mainnet": { type: "boolean", default: false },
    "wait-minutes": { type: "string", default: "15" },
  },
});

if ((values.side !== "buy" && values.side !== "sell") || !values.asset || !values.usd) {
  console.error('usage: pnpm live:trade --side buy|sell --asset NVDA --usd 30 [--reason "..."] [--confirm-mainnet]');
  process.exit(1);
}

const { deps, vaultId } = await buildLiveDeps(process.env);
const res = await runLiveTrade(
  deps,
  {
    vaultId,
    side: values.side,
    asset: values.asset,
    amountUsd: Number(values.usd),
    reason: values.reason ?? "",
    confirmMainnet: values["confirm-mainnet"] === true,
    maxUsd: Number(process.env.NORR_LIVE_MAX_USD ?? 35),
    waitMinutes: Number(values["wait-minutes"]),
  },
  (line) => console.log(line),
);
process.exit(res.exitCode);
