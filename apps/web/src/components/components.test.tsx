// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Policy } from "@norr/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem, PendingItem } from "../lib/api";
import { ActivityList, describe as describeDecision } from "./ActivityList";
import { KillSwitch } from "./KillSwitch";
import { PendingChecks } from "./PendingChecks";
import { fromForm, PolicyForm, toForm } from "./PolicyForm";

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
  const item = (over: Partial<ActivityItem>): ActivityItem => ({ id: "1", at: "2026-11-03T11:30:00Z", side: "buy", asset: "NVDA", amountUsd: 40, reason: "", decision: { status: "blocked", code: "OVER_TRADE_LIMIT", message: "$150 is over the limit." }, note: null, pending: false, ...over });

  it("shows refusals with their code, and the agent's reasoning labelled as owner-only", () => {
    render(<ActivityList now={Date.parse("2026-11-03T12:00:00Z")} items={[item({ reason: "momentum after earnings" })]} />);
    expect(screen.getByText("Refused")).toBeTruthy();
    expect(screen.getByText(/OVER_TRADE_LIMIT/)).toBeTruthy();
    expect(screen.getByText(/visible only to you/)).toBeTruthy();
    expect(screen.getByText(/momentum after earnings/)).toBeTruthy();
    expect(screen.getByText("30 minutes ago")).toBeTruthy();
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
