// Ask 1Click for a one-time deposit address that credits the demo vault's confidential balance.
// This only REQUESTS the address; nothing is sent. The owner sends the USDC from their own wallet.
//   pnpm exec tsx scripts/funding-quote.mts --usdc 1 --from <your-account>.near
import { OneClick } from "../packages/intents/src/oneclick";
import { parseArgs } from "node:util";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env */
}
const { values } = parseArgs({ options: { usdc: { type: "string", default: "1" }, from: { type: "string" } } });
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const vault = process.env.OUTLAYER_DEMO_ACCOUNT_ID;
const usdc = Number(values.usdc);
if (!vault || !values.from || !(usdc >= 1 && usdc <= 1000)) {
  console.error("usage: --usdc 1..1000 --from <the NEAR account you will send from (refunds go there)>; needs OUTLAYER_DEMO_ACCOUNT_ID");
  process.exit(1);
}
const oc = new OneClick({ apiKey: process.env.ONECLICK_API_KEY, baseUrl: process.env.ONECLICK_BASE_URL });
const o = await oc.requestDeposit({ token: USDC, amount: String(Math.round(usdc * 1e6)), recipient: vault, refundTo: values.from });
console.log(JSON.stringify({ ...o, sendUsdc: Number(o.amountIn) / 1e6, creditedUsdc: Number(o.amountOut) / 1e6, minCreditedUsdc: Number(o.minAmountOut) / 1e6, vaultAccountEnds: vault.slice(-6), refundTo: values.from, asset: "USDC on NEAR", contract: USDC.replace("nep141:", "") }, null, 2));
