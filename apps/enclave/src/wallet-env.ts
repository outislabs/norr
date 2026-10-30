/**
 * Which custody wallet the live service uses. Default: OUTLAYER_API_KEY / OUTLAYER_ACCOUNT_ID.
 * With NORR_WALLET=demo: OUTLAYER_DEMO_API_KEY / OUTLAYER_DEMO_ACCOUNT_ID (the fresh demo vault's wallet).
 * Never mixes the two: a missing demo variable is an error, not a silent fall back to the other wallet.
 */
export function walletCredentials(env: NodeJS.ProcessEnv): { apiKey: string; accountId: string; which: "default" | "demo" } {
  const which = env.NORR_WALLET === "demo" ? "demo" : "default";
  if (env.NORR_WALLET && env.NORR_WALLET !== "demo" && env.NORR_WALLET !== "default") {
    throw new Error(`unknown NORR_WALLET "${env.NORR_WALLET}" (use "demo" or leave unset)`);
  }
  const prefix = which === "demo" ? "OUTLAYER_DEMO_" : "OUTLAYER_";
  const apiKey = env[`${prefix}API_KEY`];
  const accountId = env[`${prefix}ACCOUNT_ID`];
  if (!apiKey) throw new Error(`missing environment variable ${prefix}API_KEY (see .env.example)`);
  if (!accountId) throw new Error(`missing environment variable ${prefix}ACCOUNT_ID (see .env.example)`);
  return { apiKey, accountId, which };
}
