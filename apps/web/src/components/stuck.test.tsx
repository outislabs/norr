// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, ExitResult, Holding } from "../lib/api";
import { parseRoute, withdrawHref } from "../lib/route";
import { StuckPositions, topUpEstimate } from "./StuckPositions";
import { WithdrawPanel } from "./WithdrawPanel";

afterEach(cleanup);

const dust: Holding = { assetId: "nep141:nvdaon", symbol: "NVDAon", class: "equity", amount: 0.016, valueUsd: 3.2, layer: "confidential", ticker: "NVDA", minSellUsd: 5.1, belowMinSell: true };
const fine: Holding = { assetId: "nep141:tslaon", symbol: "TSLAon", class: "equity", amount: 0.1, valueUsd: 30, layer: "confidential", ticker: "TSLA", minSellUsd: 5.1 };
const usdc: Holding = { assetId: "nep141:usdc", symbol: "USDC", class: "crypto", amount: 50, valueUsd: 50, layer: "confidential" };

describe("positions too small to sell", () => {
  it("lists only the stuck positions, with the real reason and both ways out", () => {
    render(<StuckPositions holdings={[dust, fine, usdc]} onExit={vi.fn()} withdrawHref={(a) => withdrawHref("v_1", a)} />);
    const section = screen.getByTestId("stuck-positions");
    expect(section.textContent).toContain("NVDAon");
    expect(section.textContent).toContain("below the minimum sell size of ~$5.10");
    expect(section.textContent).not.toContain("TSLAon");
    expect(screen.getByRole("link", { name: "Withdraw to my wallet" }).getAttribute("href")).toBe("#/vault/v_1/withdraw/nep141%3Anvdaon");
    expect(screen.getByRole("button", { name: "Top up and sell all" })).toBeTruthy();
  });

  it("renders nothing when every position can be sold", () => {
    const { container } = render(<StuckPositions holdings={[fine, usdc]} onExit={vi.fn()} withdrawHref={() => "#"} />);
    expect(container.textContent).toBe("");
  });

  it("top up and sell all: says what it will buy and sell, runs only after a confirm, and shows the outcome", async () => {
    const result: ExitResult = { status: "waiting", steps: [], message: "The top-up buy ($5.10 of NVDAon) waits for the owner's approval. Once it has run, call this again to sell the whole position." };
    const onExit = vi.fn(async () => result);
    render(<StuckPositions holdings={[dust]} onExit={onExit} withdrawHref={() => "#"} />);
    fireEvent.click(screen.getByRole("button", { name: "Top up and sell all" }));
    expect(onExit).not.toHaveBeenCalled();
    expect(screen.getByTestId("stuck-positions").textContent).toContain(`Buys about $${topUpEstimate(3.2, 5.1).toFixed(2)} of NVDAon`);
    fireEvent.click(screen.getByRole("button", { name: "Confirm top up and sell all" }));
    expect(onExit).toHaveBeenCalledWith("nep141:nvdaon");
    expect((await screen.findByRole("status")).textContent).toContain("waits for the owner's approval");
  });

  it("a stopped exit is shown as an alert with the reason", async () => {
    render(<StuckPositions holdings={[dust]} onExit={async () => ({ status: "stopped", steps: [], message: "The top-up buy did not run: This vault is paused." })} withdrawHref={() => "#"} />);
    fireEvent.click(screen.getByRole("button", { name: "Top up and sell all" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm top up and sell all" }));
    expect((await screen.findByRole("alert")).textContent).toContain("paused");
  });
});

describe("Withdraw to my wallet opens the existing withdraw flow for that token", () => {
  it("the route carries the token", () => {
    expect(parseRoute(withdrawHref("v_1", "nep141:nvdaon"))).toEqual({ name: "vault", id: "v_1", tab: "withdraw", asset: "nep141:nvdaon" });
    expect(parseRoute("#/vault/v_1/withdraw")).toEqual({ name: "vault", id: "v_1", tab: "withdraw" });
  });

  it("the withdraw panel starts on that token, all of it", () => {
    render(<WithdrawPanel api={{} as Api} vaultId="v_1" owner="norrfi.near" holdings={[usdc, dust]} initialAsset="nep141:nvdaon" />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("nep141:nvdaon");
    expect((screen.getByLabelText(/Amount/) as HTMLInputElement).value).toBe("Everything the vault holds");
  });

  it("an unknown token falls back to the first holding", () => {
    render(<WithdrawPanel api={{} as Api} vaultId="v_1" owner="norrfi.near" holdings={[usdc]} initialAsset="nep141:gone" />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("nep141:usdc");
  });
});
