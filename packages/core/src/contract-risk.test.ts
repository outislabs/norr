import { describe, expect, it } from "vitest";
import { contractSummary, type ContractCheck } from "./contract-risk";
import { scoreCryptoRisk, type CryptoSignals } from "./risk";
import { registry, RUG, SOL } from "./fixtures";

const healthy: CryptoSignals = { routable: true, liquidityUsd: 5e6, marketCapUsd: 1e9, ageDays: 900 };
const evm = (data: Record<string, string>): ContractCheck => ({ status: "ok", source: "goplus", family: "evm", chainId: "8453", address: "0xabc", data });
const reg = registry();
const token = reg.byId(RUG.assetId)!; // not on the majors allowlist, so the contract checks count
const major = reg.byId(SOL.assetId)!;

describe("contract checks in Scam Shield (GoPlus)", () => {
  it("a honeypot is high risk on its own, whatever the market data says", () => {
    const r = scoreCryptoRisk(token, { ...healthy, contract: evm({ is_honeypot: "1", is_open_source: "1" }) });
    expect(r.level).toBe("high");
    expect(r.reasons).toContain("Honeypot: holders cannot sell it.");
    expect(r.contract).toMatchObject({ source: "goplus", status: "ok", trusted: false });
  });

  it("owner privileges add up, each with its reason", () => {
    const r = scoreCryptoRisk(token, { ...healthy, contract: evm({ owner_change_balance: "1", is_blacklisted: "1", is_mintable: "1", is_open_source: "1" }) });
    expect(r.score).toBe(95);
    expect(r.level).toBe("high");
    expect(r.reasons).toEqual(expect.arrayContaining(["The owner can change holders' balances.", "The owner can blacklist addresses.", "The owner can mint more tokens."]));
  });

  it("owner-only functions do not count once ownership is renounced for good (PEPE's real GoPlus answer)", () => {
    const pepe = evm({ owner_address: "0x0000000000000000000000000000000000000000", is_blacklisted: "1", transfer_pausable: "1", can_take_back_ownership: "0", hidden_owner: "0", owner_change_balance: "0", is_mintable: "0", is_open_source: "1" });
    const r = scoreCryptoRisk(token, { ...healthy, contract: pepe });
    expect(r.score).toBe(0);
    expect(r.contract!.findings).toEqual(["Ownership is renounced, so owner-only functions in the contract (such as blacklisting or pausing) can no longer be used."]);
    // An owner that can take ownership back is not renounced.
    expect(scoreCryptoRisk(token, { ...healthy, contract: evm({ owner_address: "0x0000000000000000000000000000000000000000", is_blacklisted: "1", can_take_back_ownership: "1", is_open_source: "1" }) }).score).toBe(50);
    // An empty owner means unknown, not renounced.
    expect(scoreCryptoRisk(token, { ...healthy, contract: evm({ owner_address: "", is_blacklisted: "1", is_open_source: "1" }) }).score).toBe(25);
  });

  it("taxes above 10% count, above 50% count more", () => {
    expect(scoreCryptoRisk(token, { ...healthy, contract: evm({ buy_tax: "0.05", sell_tax: "0.12", is_open_source: "1" }) })).toMatchObject({ score: 30, reasons: ["Sell tax is 12%."] });
    expect(scoreCryptoRisk(token, { ...healthy, contract: evm({ sell_tax: "0.6", is_open_source: "1" }) }).score).toBe(60);
  });

  it("a token on GoPlus's trusted list is not penalised for privileges its issuer keeps (a stablecoin's mint authority)", () => {
    const usdcBase = evm({ is_honeypot: "0", buy_tax: "0", sell_tax: "0", is_open_source: "1", is_proxy: "1", trust_list: "1" });
    const r = scoreCryptoRisk(token, { ...healthy, contract: usdcBase });
    expect(r.score).toBe(0);
    expect(r.contract!.findings).toEqual(["On GoPlus's trusted list; no contract risks found."]);
    const usdcSol: ContractCheck = { status: "ok", source: "goplus", family: "solana", address: "EPj", data: { mintable: { status: "1" }, freezable: { status: "1" }, closable: { status: "0" }, trusted_token: 1 } };
    expect(scoreCryptoRisk(token, { ...healthy, contract: usdcSol }).score).toBe(0);
  });

  it("Solana: live mint and freeze authority, mutable balances and transfer fees are named", () => {
    const sol: ContractCheck = { status: "ok", source: "goplus", family: "solana", address: "M1nt", data: { mintable: { status: "1" }, freezable: { status: "1" }, balance_mutable_authority: { status: "1" }, transfer_fee: { current_fee_rate: { fee_rate: "0.2" } } } };
    const r = scoreCryptoRisk(token, { ...healthy, contract: sol });
    expect(r.reasons).toEqual(expect.arrayContaining(["Mint authority is active: more tokens can be minted.", "Freeze authority is active: holders' accounts can be frozen.", "An authority can change holders' balances.", "Transfer tax is 20%."]));
    expect(r.level).toBe("high");
  });

  it("never passes silently: not covered, no data and unreachable each say so and add a little risk", () => {
    const cases: [ContractCheck, RegExp, number][] = [
      [{ status: "not_covered", reason: "GoPlus does not cover the near chain" }, /not checked, GoPlus does not cover the near chain/, 10],
      [{ status: "no_data", address: "0xabc" }, /no data for this contract/, 15],
      [{ status: "unreachable", error: "timeout" }, /could not be reached/, 15],
    ];
    for (const [c, why, points] of cases) {
      const r = scoreCryptoRisk(token, { ...healthy, contract: c });
      expect(r.score).toBe(points);
      expect(r.reasons.join(" ")).toMatch(why);
      expect(r.contract!.status).toBe(c.status);
    }
  });

  it("known majors stay low, and still show what GoPlus said", () => {
    const r = scoreCryptoRisk(major, { ...healthy, contract: { status: "unreachable", error: "x" } });
    expect(r).toMatchObject({ score: 0, level: "low", reasons: ["Known stablecoin or major asset."] });
    expect(r.contract!.status).toBe("unreachable");
  });

  it("summaries are plain sentences", () => {
    expect(contractSummary(evm({ is_open_source: "0" })).findings).toEqual(["The contract source is not verified (closed source)."]);
    expect(contractSummary(evm({ is_open_source: "1" })).findings).toEqual(["No contract risks found."]);
  });
});
