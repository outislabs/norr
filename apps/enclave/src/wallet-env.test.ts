import { describe, expect, it } from "vitest";
import { walletCredentials } from "./wallet-env";

const env = { OUTLAYER_API_KEY: "wk_default", OUTLAYER_ACCOUNT_ID: "acct-default", OUTLAYER_DEMO_API_KEY: "wk_demo", OUTLAYER_DEMO_ACCOUNT_ID: "acct-demo" };

describe("walletCredentials", () => {
  it("uses the default wallet unless NORR_WALLET=demo", () => {
    expect(walletCredentials(env)).toEqual({ apiKey: "wk_default", accountId: "acct-default", which: "default" });
    expect(walletCredentials({ ...env, NORR_WALLET: "default" }).which).toBe("default");
    expect(walletCredentials({ ...env, NORR_WALLET: "demo" })).toEqual({ apiKey: "wk_demo", accountId: "acct-demo", which: "demo" });
  });
  it("never falls back to the other wallet", () => {
    const { OUTLAYER_DEMO_API_KEY: _k, ...noDemoKey } = env;
    expect(() => walletCredentials({ ...noDemoKey, NORR_WALLET: "demo" })).toThrow(/OUTLAYER_DEMO_API_KEY/);
    const { OUTLAYER_ACCOUNT_ID: _a, ...noAcct } = env;
    expect(() => walletCredentials(noAcct)).toThrow(/OUTLAYER_ACCOUNT_ID/);
  });
  it("rejects an unknown wallet name", () => {
    expect(() => walletCredentials({ ...env, NORR_WALLET: "prod" })).toThrow(/unknown NORR_WALLET/);
  });
});
