// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api, type DirectDeposit } from "../lib/api";
import { DirectDepositPanel, PublicBalance } from "./DirectDeposit";
import { FundingPanel } from "./FundingPanel";

afterEach(cleanup);

const dd: DirectDeposit = {
  contractId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  methodName: "ft_transfer_call",
  args: { receiver_id: "intents.near", amount: "5000000", msg: "6e4fbb15ecbaf5e85716b671d4f24ec78a3c15c5369795008ea08594b0477fc5" },
  gas: "100000000000000",
  deposit: "1",
  amountUsdc: 5,
  recipient: "6e4fbb15ecbaf5e85716b671d4f24ec78a3c15c5369795008ea08594b0477fc5",
  note: "This deposit is public: the sender, the vault's account and the amount are visible on chain until you move it into the confidential layer (Move into the confidential layer, then approve).",
};

describe("direct NEAR deposit", () => {
  it("the Fund tab shows it only when the service offers it after 1Click refused", async () => {
    const sources = [{ assetId: "nep141:usdc", symbol: "USDC", chain: "near", chainName: "NEAR", family: "near", decimals: 6, contract: null, priceUsd: 1 }];
    const requestFunding = vi.fn().mockRejectedValueOnce(new ApiError(503, "1Click is not quoting deposits from USDC on NEAR into the vault right now", { error: "x", directDeposit: dd }));
    const api = { fundingSources: vi.fn(async () => ({ sources })), requestFunding, vault: vi.fn(async () => ({ portfolio: { holdings: [] } })) } as unknown as Api;
    render(<FundingPanel api={api} vaultId="v_1" account="alice.near" />);
    expect(screen.queryByTestId("direct-deposit")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /Get a deposit address/ }));
    expect(await screen.findByText(/1Click is not quoting deposits/)).toBeTruthy();
    expect(await screen.findByTestId("direct-deposit")).toBeTruthy();
    expect(screen.getByText(/visible on chain until you move it into the confidential layer/)).toBeTruthy();
  });

  it("sends the exact call from the connected wallet and says from which account", async () => {
    const send = vi.fn(async () => "legalalienx.near");
    render(<DirectDepositPanel api={{} as Api} deposit={dd} send={send} />);
    fireEvent.click(screen.getByRole("button", { name: "Send with my NEAR wallet" }));
    expect(await screen.findByText(/Sent from legalalienx\.near/)).toBeTruthy();
    expect(send).toHaveBeenCalledWith({}, dd);
  });

  it("the public balance offers the move into the confidential layer, and says it waits for approval", async () => {
    const shield = vi.fn(async () => ({ status: "pending_approval" as const, amountUsdc: 5, message: "Waiting for your approval: move 5 USDC into the confidential layer. Approve it in Approvals." }));
    const api = { vault: vi.fn(async () => ({ portfolio: { holdings: [{ symbol: "USDC", layer: "public", amount: 5 }, { symbol: "USDC", layer: "confidential", amount: 2 }] } })), shield } as unknown as Api;
    render(<PublicBalance api={api} vaultId="v_1" />);
    expect(await screen.findByText("5 USDC")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move into the confidential layer" }));
    await waitFor(() => expect(screen.getByText(/Waiting for your approval: move 5 USDC/)).toBeTruthy());
    expect(screen.getByRole("link", { name: "Open Approvals" }).getAttribute("href")).toBe("#/vault/v_1/approvals");
  });

  it("shows nothing when the vault holds no public USDC", async () => {
    const api = { vault: vi.fn(async () => ({ portfolio: { holdings: [{ symbol: "USDC", layer: "confidential", amount: 2 }] } })) } as unknown as Api;
    render(<PublicBalance api={api} vaultId="v_1" />);
    await waitFor(() => expect(api.vault).toHaveBeenCalled());
    expect(screen.queryByTestId("public-balance")).toBeNull();
  });
});
