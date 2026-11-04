import { describe, expect, it } from "vitest";
import { buildCustodyPolicy, custodyPolicyProblems, describeCustodyPolicy } from "./custody-policy";

const WALLET = "882c084a64e1648a150867ef4b62c82a555b34cfb8a075caeeec3e51eb56aca0";
const USDC = { id: "nep141:usdc", decimals: 6, priceUsd: 1 };
const SOL = { id: "nep141:sol.omft.near", decimals: 9, priceUsd: 100 };
const base = { owner: "alice.near", walletAccount: WALLET, assets: [USDC, SOL, USDC], maxTradeUsd: 10, dailyCapUsd: 30, autonomous: false };

describe("the default custody policy for a new vault", () => {
  it("allows confidential operations only, sends only to the owner or the vault, and needs the owner's approval", () => {
    const p = buildCustodyPolicy(base);
    expect(p.rules.transaction_types).toEqual(["confidential"]);
    expect(p.rules.addresses).toEqual({ mode: "whitelist", list: ["alice.near", WALLET] });
    expect(p.approval).toEqual({ threshold: { required: 1 }, approvers: [{ id: "alice.near", role: "admin" }] });
    expect(p.capabilities).toEqual({ confidential: { allowed: true }, evm_sign: { allowed: false }, solana_sign: { allowed: false } });
    expect(p.rules.allowed_tokens).toEqual([USDC.id, SOL.id]);
    expect(p.rules.rate_limit).toEqual({ max_per_hour: 10 });
  });

  it("converts the USD caps to token units with 25% headroom", () => {
    const p = buildCustodyPolicy(base);
    expect(p.rules.limits.per_transaction).toEqual({ [USDC.id]: "12500000", [SOL.id]: "125000000" });
    expect(p.rules.limits.daily).toEqual({ [USDC.id]: "37500000", [SOL.id]: "375000000" });
    expect(p.rules.limits.hourly).toEqual(p.rules.limits.daily);
  });

  it("autonomous mode is the owner's choice and changes only the approval exclusion", () => {
    const a = buildCustodyPolicy({ ...base, autonomous: true });
    const b = buildCustodyPolicy(base);
    expect(a.approval.excluded_types).toEqual(["confidential"]);
    expect({ ...a, approval: { ...a.approval, excluded_types: undefined } }).toEqual({ ...b, approval: { ...b.approval, excluded_types: undefined } });
    expect(describeCustodyPolicy(a, 10, 30).join(" ")).toMatch(/Autonomous/);
    expect(describeCustodyPolicy(b, 10, 30).join(" ")).toMatch(/waits for your approval/);
  });

  it("refuses inputs that would make a weaker policy", () => {
    expect(() => buildCustodyPolicy({ ...base, owner: "Not An Account" })).toThrow();
    expect(() => buildCustodyPolicy({ ...base, walletAccount: "bob.near" })).toThrow();
    expect(() => buildCustodyPolicy({ ...base, dailyCapUsd: 5 })).toThrow();
    expect(() => buildCustodyPolicy({ ...base, assets: [] })).toThrow();
  });

  it("the check accepts the stored policy in any key order, and names every difference", () => {
    const p = buildCustodyPolicy(base);
    const stored = JSON.parse(JSON.stringify({ capabilities: p.capabilities, approval: p.approval, rules: { ...p.rules, addresses: { list: [WALLET, "alice.near"], mode: "whitelist" } }, frozen: false }));
    expect(custodyPolicyProblems(p, stored)).toEqual([]);
    expect(custodyPolicyProblems(p, { ...stored, rules: { ...stored.rules, addresses: { mode: "whitelist", list: ["alice.near", "mallory.near"] } } })).toEqual(["The address whitelist differs."]);
    expect(custodyPolicyProblems(p, { ...stored, approval: { ...stored.approval, excluded_types: ["confidential"] } })).toEqual(["Approvers or approval settings differ."]);
    expect(custodyPolicyProblems(p, { ...stored, frozen: true })).toEqual(["The wallet is frozen."]);
    expect(custodyPolicyProblems(p, {})).toEqual(["The custody provider holds no policy for this wallet."]);
  });
});
