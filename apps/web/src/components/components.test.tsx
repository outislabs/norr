// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Policy } from "@norr/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem, PendingItem } from "../lib/api";
import { ActivityList, describe as describeDecision } from "./ActivityList";
import { KillSwitch } from "./KillSwitch";
import { PendingChecks } from "./PendingChecks";
import { fromForm, PolicyForm, toForm } from "./PolicyForm";
import { FundingPanel } from "./FundingPanel";
import type { Api, FundingOffer, FundingStatus } from "../lib/api";

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
  const p: PendingItem = { ledgerId: "l1", requestId: "r1", requestHash: "abc123", venue: "confidential", sends: { symbol: "USDC", amount: 40 }, receivesAtLeast: { symbol: "NVDAon", amount: 0.19 }, recipient: "882c084a64e1648a150867ef4b62c82a555b34cfb8a075caeeec3e51eb56aca0", check: "Approve only if the approval screen matches." };

  it("spells out what Norr asked for, with the hash and a link to the approval screen", () => {
    render(<PendingChecks items={[p]} />);
    expect(screen.getByText(/Norr asked to send/)).toBeTruthy();
    expect(screen.getByText("abc123")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the approval screen" }).getAttribute("href")).toBe("https://app.outlayer.ai/wallet/approvals");
    expect(screen.getByText(/Approve only if/)).toBeTruthy();
  });

  it("says when nothing is waiting", () => {
    render(<PendingChecks items={[]} />);
    expect(screen.getByText("Nothing is waiting for your approval.")).toBeTruthy();
  });
});

describe("FundingPanel", () => {
  const offer: FundingOffer = { id: "f1", address: "49e108dd75c0114f46b00b384c61bde9f6b4b4805cac85ab20f6dacf5452693b", amountUsdc: 8, asset: { symbol: "USDC", chain: "NEAR", contract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" }, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
  const fakeApi = (status: () => FundingStatus, request: () => Promise<FundingOffer> = async () => offer) =>
    ({ requestFunding: vi.fn(request), fundingStatus: vi.fn(async () => status()) }) as unknown as Api;

  it("shows the address, amount, asset, network and the warnings, then reports the arrival", async () => {
    let s: FundingStatus = { state: "waiting", receivedUsdc: 0, balanceUsdc: 0, expiresAt: offer.expiresAt, reportedBy: "custody provider" };
    const api = fakeApi(() => s);
    const arrived = vi.fn();
    render(<FundingPanel api={api} vaultId="demo" pollMs={10} onArrived={arrived} />);
    fireEvent.change(screen.getByLabelText("Amount in USDC"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Get a deposit address" }));
    expect((await screen.findByTestId("deposit-address")).textContent).toBe(offer.address);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Send exactly 8 USDC on NEAR");
    expect(text).toContain(offer.asset.contract);
    expect(text).toContain("character by character");
    expect(text).toContain("normal public transaction");
    expect(api.requestFunding).toHaveBeenCalledWith("demo", 8, undefined);

    s = { ...s, state: "arrived", receivedUsdc: 8, balanceUsdc: 15.93 };
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Arrived: $8.00 USDC"));
    expect(arrived).toHaveBeenCalled();
    expect(screen.queryByTestId("deposit-address")).toBeNull();
  });

  it("shows why it failed and keeps the form", async () => {
    const api = fakeApi(() => { throw new Error("unused"); }, async () => { throw new Error("Could not get a deposit address from the custody provider."); });
    render(<FundingPanel api={api} vaultId="demo" />);
    fireEvent.click(screen.getByRole("button", { name: "Get a deposit address" }));
    expect((await screen.findByRole("alert")).textContent).toContain("custody provider");
    expect(screen.queryByTestId("deposit-address")).toBeNull();
  });
});
