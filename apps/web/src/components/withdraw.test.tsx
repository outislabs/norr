// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api, type Holding, type WithdrawPlan } from "../lib/api";
import { canApprove, checkApproval, sha256Hex, type ApprovalDetail } from "../lib/approvals";
import { ActivityTab } from "./ActivityTab";
import { WithdrawPanel } from "./WithdrawPanel";

afterEach(cleanup);

const holdings: Holding[] = [{ assetId: "nep141:usdc", symbol: "USDC", class: "crypto", amount: 12.5, valueUsd: 12.5, layer: "confidential" }];
const plan: WithdrawPlan = { asset: "USDC", assetId: "nep141:usdc", amount: "1", balance: "12.5", destination: "norrfi.near", chain: "near", layer: "confidential", approval: "Waits for your approval in the Approvals tab.", becomesPublic: "The arrival is public on NEAR: 1 USDC landing in norrfi.near." };

describe("withdraw panel", () => {
  it("shows the fixed destination, checks first without moving anything, then requests", async () => {
    const withdraw = vi.fn(async (_id: string, b: { dryRun?: boolean }) => (b.dryRun ? { dryRun: true as const, plan } : { status: "pending_approval" as const, requestId: "r1", plan, message: "Waiting for your approval: withdraw 1 USDC to norrfi.near. Approve it in Approvals." }));
    const onRequested = vi.fn();
    render(<WithdrawPanel api={{ withdraw } as unknown as Api} vaultId="v_1" owner="norrfi.near" holdings={holdings} onRequested={onRequested} />);
    expect(screen.getByTestId("withdraw-destination").textContent).toBe("norrfi.near");
    expect(screen.queryByRole("textbox", { name: /destination/i })).toBeNull(); // not editable
    expect(screen.queryByRole("button", { name: /Request this withdrawal/ })).toBeNull(); // nothing to send before the check
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /Check first/ }));
    expect(await screen.findByTestId("withdraw-plan")).toBeTruthy();
    expect(withdraw).toHaveBeenLastCalledWith("v_1", { asset: "nep141:usdc", dryRun: true, amount: "1" });
    expect(screen.getByText(/What becomes public/)).toBeTruthy();
    expect(screen.getByText(/The arrival is public on NEAR/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Request this withdrawal/ }));
    expect(await screen.findByText(/Waiting for your approval/)).toBeTruthy();
    expect(withdraw).toHaveBeenLastCalledWith("v_1", { asset: "nep141:usdc", dryRun: false, amount: "1" });
    expect(onRequested).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Open Approvals" }).getAttribute("href")).toBe("#/vault/v_1/approvals");
  });

  it("Max asks for everything held, and changing the amount drops a stale check", async () => {
    const withdraw = vi.fn(async () => ({ dryRun: true as const, plan }));
    render(<WithdrawPanel api={{ withdraw } as unknown as Api} vaultId="v_1" owner="norrfi.near" holdings={holdings} />);
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    fireEvent.click(screen.getByRole("button", { name: /Check first/ }));
    await screen.findByTestId("withdraw-plan");
    expect(withdraw).toHaveBeenCalledWith("v_1", { asset: "nep141:usdc", dryRun: true, max: true });
    fireEvent.click(screen.getByRole("button", { name: "Enter an amount" }));
    expect(screen.queryByTestId("withdraw-plan")).toBeNull();
  });

  it("shows the service's plain error, and explains an empty confidential balance", async () => {
    const withdraw = vi.fn(async () => {
      throw new ApiError(400, "Insufficient balance: you asked for 99 USDC and the vault's confidential balance is 12.5 USDC.", { error: "x" });
    });
    render(<WithdrawPanel api={{ withdraw } as unknown as Api} vaultId="v_1" owner="norrfi.near" holdings={holdings} />);
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: /Check first/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Insufficient balance/);
    cleanup();
    render(<WithdrawPanel api={{} as Api} vaultId="v_1" owner="norrfi.near" holdings={[]} />);
    expect(screen.getByText(/holds nothing in its confidential balance/)).toBeTruthy();
    expect(screen.queryByTestId("withdraw-destination")).toBeNull();
  });
});

describe("a withdrawal approval", () => {
  const op = { kind: "confidential", flow: "withdraw", token: "nep141:usdc", amount: "1000000", to: "norrfi.near", chain: "near" };
  const intended = { tokenIn: "nep141:usdc", amountIn: "1000000", tokenOut: "nep141:usdc", minAmountOut: "1000000", destination: "norrfi.near" };
  async function detail(o: unknown): Promise<ApprovalDetail> {
    const op_canonical = JSON.stringify(o);
    return { id: "a1", status: "pending", request_type: "confidential", op_canonical, request_hash: await sha256Hex(op_canonical), wallet_pubkey: "ed25519:W", expires_at: new Date(Date.now() + 3600_000).toISOString() };
  }

  it("can be approved only when the operation names the owner as destination", async () => {
    const good = await detail(op);
    expect(canApprove(await checkApproval(good, intended), good)).toBe(true);
    const redirected = await detail({ ...op, to: "mallory.near" });
    const c = await checkApproval(redirected, intended);
    expect(c.matchesNorr).toBe(false);
    expect(c.problems.join(" ")).toMatch(/destination account/);
    expect(canApprove(c, redirected)).toBe(false);
    const bigger = await detail({ ...op, amount: "100000000" });
    expect(canApprove(await checkApproval(bigger, intended), bigger)).toBe(false);
  });
});

describe("activity", () => {
  it("lists withdrawals beside the agent's decisions", () => {
    const transfers = [
      { id: "wd-1", at: new Date().toISOString(), kind: "withdraw" as const, symbol: "USDC", amount: "1", to: "norrfi.near", state: "waiting" as const, detail: null },
      { id: "wd-2", at: new Date().toISOString(), kind: "withdraw" as const, symbol: "USDC", amount: "2", to: "norrfi.near", state: "failed" as const, detail: "Rejected. Nothing moved." },
    ];
    render(<ActivityTab api={{ sealKey: vi.fn(async () => ({ publicKey: null })) } as unknown as Api} account="norrfi.near" vaultId="v_1" items={[]} transfers={transfers} reload={() => undefined} />);
    expect(screen.getByTestId("transfer-wd-1").textContent).toMatch(/Waiting for you.*Withdraw 1 USDC to norrfi\.near/);
    expect(screen.getByTestId("transfer-wd-2").textContent).toMatch(/Failed.*Rejected\. Nothing moved\./);
    void waitFor;
  });
});
