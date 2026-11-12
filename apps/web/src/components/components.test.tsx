// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Policy } from "@norr/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem, PendingItem } from "../lib/api";
import { ActivityList, describe as describeDecision } from "./ActivityList";
import { KillSwitch } from "./KillSwitch";
import { PendingChecks } from "./PendingChecks";
import { fromForm, PolicyForm, toForm } from "./PolicyForm";
import { FundingPanel } from "./FundingPanel";
import { AttestationPanel, DetailText } from "./AttestationPanel";
import type { Qvl } from "../lib/qvl";
import { fixture } from "../../../../packages/shared/src/attestation.fixture";
import type { Api, FundingOffer, FundingSource, FundingStatus } from "../lib/api";

afterEach(cleanup);

const policy: Policy = {
  vaultId: "demo", maxTradeUsd: 50, dailySpendCapUsd: 150, dailyLossCapUsd: 25, maxEquityPct: 60, allowedCrypto: "any_safe",
  allowedEquities: ["NVDA", "TSLA"], cooldownSec: 10, paused: false, nonUsConfirmed: false, allowMediumRisk: false, privacy: "prefer",
};

describe("PolicyForm", () => {
  it("round-trips a policy through the form unchanged", () => {
    const r = fromForm(toForm(policy), policy);
    expect(r).toEqual({ policy });
  });

  it("a preset fills the limits but never confirms non-US status or changes the privacy mode", () => {
    const onSave = vi.fn(async () => undefined);
    render(<PolicyForm policy={{ ...policy, privacy: "require" }} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Degen" }));
    expect((screen.getByLabelText("Largest single trade (USD)") as HTMLInputElement).value).toBe("200");
    expect((screen.getByRole("checkbox", { name: /not a US person/i }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("radio", { name: /Confidential only/i }) as HTMLInputElement).checked).toBe(true);
  });

  it("saves the edited rules, with the vault id fixed, and says so", async () => {
    const onSave = vi.fn(async (_p: Policy) => undefined);
    render(<PolicyForm policy={policy} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Largest single trade (USD)"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /not a US person/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ vaultId: "demo", maxTradeUsd: 20, nonUsConfirmed: true, paused: false });
    expect((await screen.findByRole("status")).textContent).toContain("Saved");
  });

  it("refuses a bad number in plain words and does not call save", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<PolicyForm policy={policy} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Largest single trade (USD)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Largest single trade");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows a save failure from the service", async () => {
    render(<PolicyForm policy={policy} onSave={async () => { throw new Error("invalid policy: nope"); }} />);
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    expect((await screen.findByRole("alert")).textContent).toContain("invalid policy: nope");
  });

  it("parses tickers and a crypto list case-insensitively", () => {
    const f = { ...toForm(policy), allowedEquities: "nvda, tsla  msft", cryptoMode: "list" as const, allowedCrypto: "btc,eth" };
    const r = fromForm(f, policy);
    expect(r).toMatchObject({ policy: { allowedEquities: ["NVDA", "TSLA", "MSFT"], allowedCrypto: ["BTC", "ETH"] } });
  });
});

describe("KillSwitch", () => {
  it("needs a second tap, can be cancelled, and only then pauses", async () => {
    const pause = vi.fn(async () => undefined);
    render(<KillSwitch onPauseAll={pause} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause everything" }));
    expect(pause).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Pause everything" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause everything" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, pause all" }));
    await waitFor(() => expect(pause).toHaveBeenCalledTimes(1));
  });

  it("shows the error and stays open if pausing fails", async () => {
    render(<KillSwitch onPauseAll={async () => { throw new Error("service down"); }} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause everything" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, pause all" }));
    expect((await screen.findByRole("alert")).textContent).toContain("service down");
  });
});

describe("ActivityList", () => {
  const item = (over: Partial<ActivityItem>): ActivityItem => ({ id: "1", executed: null, at: "2026-11-03T11:30:00Z", side: "buy", asset: "NVDA", amountUsd: 40, sealedReason: null, decision: { status: "blocked", code: "OVER_TRADE_LIMIT", message: "$150 is over the limit." }, note: null, pending: false, ...over });

  it("shows what an executed trade really moved, not the size that was asked for", () => {
    const filled = { asset: "NVDAon", amount: "0.0294", priceUsd: 201.5 };
    const sell = item({ side: "sell", amountUsd: 7, decision: { status: "executed", txRef: "r", filled, venue: "confidential", verification: "custody-reported" }, executed: { usd: 5.930068, realizedUsd: -0.071876 } });
    const buy = item({ id: "2", side: "buy", amountUsd: 6, decision: { status: "executed", txRef: "r2", filled, venue: "confidential", verification: "custody-reported" }, executed: { usd: 6.001944, realizedUsd: null } });
    const { container } = render(<ActivityList items={[sell, buy]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Sold NVDA, received $5.93 (realized loss $0.07)");
    expect(text).toContain("Bought NVDA, spent $6.00");
    expect(text).not.toContain("$7.00");
  });

  const sealed = { v: 1 as const, k: "owner" as const, epk: "e", iv: "i", ct: "c" };

  it("shows refusals with their code, and unlocked reasoning labelled as owner-only", () => {
    render(<ActivityList now={Date.parse("2026-11-03T12:00:00Z")} items={[item({ sealedReason: sealed })]} reasons={{ "1": "momentum after earnings" }} />);
    expect(screen.getByText("Refused")).toBeTruthy();
    expect(screen.getByText(/OVER_TRADE_LIMIT/)).toBeTruthy();
    expect(screen.getByText(/visible only to you/)).toBeTruthy();
    expect(screen.getByText(/momentum after earnings/)).toBeTruthy();
    expect(screen.getByText("30 minutes ago")).toBeTruthy();
  });

  it("keeps reasoning sealed until it is unlocked, and shows none for entries that had none", () => {
    const { container } = render(<ActivityList items={[item({ sealedReason: sealed }), item({ id: "2" })]} />);
    expect(container.textContent).toContain("reasoning is sealed");
    expect(container.textContent).not.toContain("visible only to you");
    expect((container.textContent?.match(/reasoning is sealed/g) ?? []).length).toBe(1);
  });

  it("labels how an executed trade was checked, and its warnings", () => {
    const executed = describeDecision({ status: "executed", txRef: "r", filled: { asset: "NVDAon", amount: "0.19", priceUsd: 208 }, venue: "confidential", verification: "custody-reported" });
    expect(executed.label).toBe("Done");
    expect(executed.detail).toContain("confidentially");
    expect(executed.detail).toContain("checked against the custody provider's own balances");
    render(<ActivityList items={[item({ decision: { status: "executed", txRef: "r", filled: { asset: "NVDAon", amount: "0.19", priceUsd: 208 }, warnings: ["Would leave $3.88."] } })]} />);
    expect(screen.getByText("Would leave $3.88.")).toBeTruthy();
  });

  it("has an honest empty state", () => {
    render(<ActivityList items={[]} />);
    expect(screen.getByText(/Nothing yet/)).toBeTruthy();
  });
});

describe("PendingChecks", () => {
  const p: PendingItem = { ledgerId: "l1", requestId: "r1", requestHash: "abc123", venue: "confidential", sends: { symbol: "USDC", amount: 5 }, receivesAtLeast: { symbol: "SOL", amount: 0.03 }, recipient: "882c084a64e1648a150867ef4b62c82a555b34cfb8a075caeeec3e51eb56aca0", check: "", approvalId: "ap-1", intended: { tokenIn: "nep141:usdc", amountIn: "5000000", tokenOut: "nep141:sol", minAmountOut: "1" } };
  const list = { pending: [p], unknown: [], approvalsListed: true, approvalsApi: "https://provider.test", voteRecipient: "outlayer.near" };
  const sha = async (t: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))), (b) => b.toString(16).padStart(2, "0")).join("");
  async function provider(op: object, tamper = false) {
    const op_canonical = JSON.stringify(op);
    const detail = { id: "ap-1", status: "pending", request_type: "confidential", request_hash: tamper ? "f".repeat(64) : await sha(op_canonical), op_canonical, wallet_pubkey: "ed25519:W", expires_at: new Date(Date.now() + 3600_000).toISOString() };
    const posts: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ status: "approved", approved: 1, required: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify(detail), { status: 200 });
    }) as unknown as typeof fetch;
    const sign = vi.fn(async () => ({ signature: "ed25519:SIG", publicKey: "ed25519:PK", accountId: "owner.near" }));
    return { detail, posts, fetchImpl, sign };
  }
  const good = { type: "swap", token_in: "nep141:usdc", amount_in: "5000000", token_out: "nep141:sol" };

  it("checks the hash in the browser, signs the exact message and sends the vote straight to the provider", async () => {
    const { detail, posts, fetchImpl, sign } = await provider(good);
    render(<PendingChecks items={[p]} list={list} owner="owner.near" fetchImpl={fetchImpl} sign={sign} />);
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(screen.getByText(/Hash checked in this browser/).textContent).toMatch(/equals/);
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(approve);
    await screen.findByText(/^Approved\./);
    expect(sign).toHaveBeenCalledWith(`approve:ap-1:ed25519:W:${detail.request_hash}`, "outlayer.near", expect.any(Uint8Array), "owner.near");
    expect(posts[0]?.url).toBe("https://provider.test/wallet/v1/approve/ap-1");
    expect(posts[0]?.body).toMatchObject({ signature: "ed25519:SIG", public_key: "ed25519:PK", account_id: "owner.near" });
  });

  it("disables Approve when the hash does not match, but still allows Reject", async () => {
    const { fetchImpl, sign } = await provider(good, true);
    render(<PendingChecks items={[p]} list={list} owner="owner.near" fetchImpl={fetchImpl} sign={sign} />);
    const approve = (await screen.findByRole("button", { name: "Approve" })) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.getByText(/does NOT equal/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Approve when the operation is not what Norr asked for", async () => {
    const { fetchImpl, sign } = await provider({ ...good, amount_in: "3400000" });
    render(<PendingChecks items={[p]} list={list} owner="owner.near" fetchImpl={fetchImpl} sign={sign} />);
    expect(((await screen.findByRole("button", { name: "Approve" })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/does not match what Norr asked for \(the amount differs\)/)).toBeTruthy();
  });

  it("an approval Norr never asked for offers only Reject", async () => {
    const { fetchImpl, sign } = await provider(good);
    render(<PendingChecks items={[]} list={{ ...list, pending: [], unknown: [{ approvalId: "ap-1", requestId: null, type: "confidential", expiresAt: "" }] }} owner="owner.near" fetchImpl={fetchImpl} sign={sign} />);
    await screen.findByRole("button", { name: "Reject" });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText(/Norr did not ask for this confidential operation/)).toBeTruthy();
  });

  it("falls back to the provider's approval screen when no approval is listed", () => {
    render(<PendingChecks items={[{ ...p, approvalId: undefined }]} list={{ ...list, approvalsListed: false }} />);
    expect(screen.getByRole("link", { name: "its approval screen" }).getAttribute("href")).toBe("https://app.outlayer.ai/wallet/approvals");
  });

  it("says when nothing is waiting", () => {
    render(<PendingChecks items={[]} />);
    expect(screen.getByText("Nothing is waiting for your approval.")).toBeTruthy();
  });
});

describe("FundingPanel", () => {
  const sources: FundingSource[] = [
    { assetId: "nep141:usdc", symbol: "USDC", chain: "near", chainName: "NEAR", family: "near", decimals: 6, contract: null, priceUsd: 1 },
    { assetId: "nep141:base-usdc", symbol: "USDC", chain: "base", chainName: "Base", family: "evm", evmChainId: 8453, decimals: 6, contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", priceUsd: 1 },
  ];
  const offer: FundingOffer = { id: "f1", address: "49e108dd75c0114f46b00b384c61bde9f6b4b4805cac85ab20f6dacf5452693b", amountUsdc: 8, amountUsd: 8, minArrivingUsdc: 7.99, refundTo: "me.near", send: { amount: "8", units: "8000000", symbol: "USDC", chain: "near", chainName: "NEAR", family: "near", contract: null, decimals: 6 }, asset: { symbol: "USDC", chain: "NEAR", contract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" }, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
  const fakeApi = (status: () => FundingStatus, request: () => Promise<FundingOffer> = async () => offer) =>
    ({ fundingSources: vi.fn(async () => ({ sources })), requestFunding: vi.fn(request), fundingStatus: vi.fn(async () => status()) }) as unknown as Api;

  it("shows the address, amount, network, a QR code and the warnings, then reports the arrival", async () => {
    let s: FundingStatus = { state: "waiting", receivedUsdc: 0, balanceUsdc: 0, expiresAt: offer.expiresAt, reportedBy: "custody provider" };
    const api = fakeApi(() => s);
    const arrived = vi.fn();
    render(<FundingPanel api={api} vaultId="demo" account="me.near" pollMs={10} onArrived={arrived} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "USDC on Base" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Amount in USD"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Get a deposit address" }));
    expect((await screen.findByTestId("deposit-address")).textContent).toBe(offer.address);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Send exactly 8 USDC on NEAR");
    expect(text).toContain("character by character");
    // The 1Click route never names the vault on chain (traced, docs/FINDINGS.md); the short line links to the detail.
    expect(screen.getByTestId("deposit-privacy").textContent).toContain("Deposits are private: they never name your vault.");
    expect(within(screen.getByTestId("deposit-privacy")).getByRole("link", { name: "Who sees what" }).getAttribute("href")).toBe("https://norr.finance/docs/privacy/");
    expect(text).not.toContain("normal public transaction");
    expect(screen.getByRole("img", { name: /QR code/ })).toBeTruthy();
    expect(api.requestFunding).toHaveBeenCalledWith("demo", { amountUsd: 8, source: "nep141:usdc", refundTo: "me.near" });

    s = { ...s, state: "arrived", receivedUsdc: 8, balanceUsdc: 15.93 };
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Arrived: $8.00 USDC"));
    expect(arrived).toHaveBeenCalled();
    expect(screen.queryByTestId("deposit-address")).toBeNull();
  });

  it("asks for an address on the chosen chain for refunds, and sends the source the owner picked", async () => {
    const api = fakeApi(() => ({ state: "waiting", receivedUsdc: 0, balanceUsdc: 0, expiresAt: offer.expiresAt, reportedBy: "custody provider" }));
    render(<FundingPanel api={api} vaultId="demo" account="me.near" />);
    await waitFor(() => expect(screen.getByRole("option", { name: "USDC on Base" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Pay with"), { target: { value: "nep141:base-usdc" } });
    const refund = screen.getByLabelText("Your Base address (refunds go here)") as HTMLInputElement;
    expect(refund.value).toBe(""); // the NEAR account is not reused for another chain
    fireEvent.change(refund, { target: { value: "0x8ba1f109551bD432803012645Ac136ddd64DBA72" } });
    fireEvent.click(screen.getByRole("button", { name: "Get a deposit address" }));
    await waitFor(() => expect(api.requestFunding).toHaveBeenCalledWith("demo", { amountUsd: 5, source: "nep141:base-usdc", refundTo: "0x8ba1f109551bD432803012645Ac136ddd64DBA72" }));
  });

  it("shows why it failed and keeps the form", async () => {
    const api = fakeApi(() => { throw new Error("unused"); }, async () => { throw new Error("Could not get a deposit address from the custody provider."); });
    render(<FundingPanel api={api} vaultId="demo" />);
    await waitFor(() => expect(screen.getByRole("option", { name: "USDC on NEAR" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Get a deposit address" }));
    expect((await screen.findByRole("alert")).textContent).toContain("custody provider");
    expect(screen.queryByTestId("deposit-address")).toBeNull();
  });
});

describe("AttestationPanel", () => {
  const passingQvl: () => Promise<Qvl> = async () => ({ getCollateral: async () => ({}), verify: () => ({ status: "UpToDate" }) });
  /** A service that answers any nonce the way an honest TEE would, or with a swapped configuration. */
  const apiFor = (tamper = false) => {
    const swapped = JSON.stringify({ docker_compose_file: "services:\n  a:\n    image: x/a:latest\n" });
    return {
      attestation: vi.fn(async (nonce: string) => ({ attested: true as const, commit: "abc123", ...fixture({ nonce }).evidence })),
      appInfo: vi.fn(async () => ({ attested: true as const, ...fixture().info, ...(tamper ? { appCompose: swapped } : {}), appId: "app-1" })),
    } as unknown as Api;
  };

  it("runs the checks in the browser against a fresh nonce and shows each result", async () => {
    const api = apiFor();
    render(<AttestationPanel api={api} qvl={passingQvl} />);
    fireEvent.click(screen.getByRole("button", { name: "Check attestation" }));
    await waitFor(() => expect(screen.getByText("The quote's signature chain is genuine")).toBeTruthy());
    const text = document.body.textContent ?? "";
    for (const label of ["The quote is a TDX quote", "The quote answers the nonce we just sent", "The configuration is the one that was measured", "The event log is the one the hardware measured"]) expect(text).toContain(label);
    expect(text).not.toMatch(/✕|fail:/);
    expect(text).toContain("Verified in this browser against Intel's root certificate");
    expect(screen.queryByRole("button", { name: "Copy the quote" })).toBeNull(); // no fallback needed
    expect(text).toContain("abc123");
    const nonce = (api.attestation as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!;
    expect(nonce).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
  });

  it("shows a swapped configuration as failed, not as a pass", async () => {
    render(<AttestationPanel api={apiFor(true)} qvl={passingQvl} />);
    fireEvent.click(screen.getByRole("button", { name: "Check attestation" }));
    await waitFor(() => expect(screen.getByText("The configuration is the one that was measured")).toBeTruthy());
    expect(document.body.textContent).toContain("✕");
    expect(document.body.textContent).toContain("Not pinned by digest");
  });

  it("offers Phala's explorer when the signature cannot be checked here, and sends the quote nowhere itself", async () => {
    const f = vi.fn(async () => new Response("{}"));
    const write = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", f);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    try {
      const unreachable: () => Promise<Qvl> = async () => ({ getCollateral: async () => { throw new Error("PCCS down"); }, verify: () => ({ status: "UpToDate" }) });
      render(<AttestationPanel api={apiFor()} qvl={unreachable} />);
      fireEvent.click(screen.getByRole("button", { name: "Check attestation" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Copy the quote" })).toBeTruthy());
      expect(document.body.textContent).toContain("skipped: The quote's signature chain is genuine");
      expect(f).not.toHaveBeenCalled(); // the quote does not leave the browser
      expect(screen.getByRole("link", { name: /Open the explorer/ }).getAttribute("href")).toBe("https://proof.t16z.com/");
      fireEvent.click(screen.getByRole("button", { name: "Copy the quote" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Quote copied" })).toBeTruthy());
      expect(write).toHaveBeenCalledOnce();
      expect((write.mock.calls[0] as unknown as string[])[0]).not.toMatch(/^0x/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("wraps sentences at word boundaries and lets only long tokens break anywhere", () => {
    render(<DetailText text={"Its report data is our nonce.\nghcr.io/outislabs/norr@sha256:011d93f0fa2cf6be08da90bdb9066573"} />);
    expect(screen.getByText("Its report data is our nonce.").className).toContain("break-words");
    expect(screen.getByText(/^ghcr\.io/).className).toContain("break-all");
  });

  it("reports a service with no TEE instead of showing checks", async () => {
    const api = { attestation: vi.fn(async () => { throw new Error("This service is not running in a TEE"); }), appInfo: vi.fn(async () => { throw new Error("x"); }) } as unknown as Api;
    render(<AttestationPanel api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Check attestation" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not running in a TEE");
  });
});
