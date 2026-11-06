// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewVault } from "../components/NewVault";
import type { Api, BetaInfo, PreparedPolicy } from "../lib/api";
import { SetupPage } from "./SetupPage";
import { AuthorizePage } from "./AuthorizePage";
import { AutonomyPanel } from "../components/AutonomyPanel";
import { VaultTitle } from "../components/VaultTitle";

afterEach(cleanup);

const beta: BetaInfo = { selfServe: true, signupsOpen: true, depositCapUsd: 100, maxVaultsPerOwner: 1, termsVersion: "2026-11-04", termsUrl: "https://norr.finance/docs/terms/" };

describe("NewVault (the empty state)", () => {
  it("creates only after the terms are accepted, sends the terms version and the non-US choice, then opens setup", async () => {
    const createVault = vi.fn(async () => ({ id: "v_abc" }));
    const navigate = vi.fn();
    render(<NewVault api={{ createVault } as unknown as Api} account="alice.near" beta={beta} navigate={navigate} />);
    const button = screen.getByRole("button", { name: "Create vault" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Up to \$100 per vault/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/I have read and accept/));
    fireEvent.click(screen.getByLabelText(/I am not a US person/));
    fireEvent.click(button);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("#/setup/v_abc"));
    expect(createVault).toHaveBeenCalledWith({ acceptTerms: "2026-11-04", nonUsConfirmed: true });
  });

  it("says plainly when new vaults are paused", () => {
    render(<NewVault api={{} as Api} account="alice.near" beta={{ ...beta, signupsOpen: false }} />);
    expect(screen.getByText("New vaults are paused for now")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create vault" })).toBeNull();
    // An invited account can still try; the service decides.
    fireEvent.click(screen.getByRole("button", { name: "I was invited" }));
    expect(screen.getByRole("button", { name: "Create vault" })).toBeTruthy();
  });
});

describe("SetupPage", () => {
  const prepared: PreparedPolicy = {
    policy: { rules: { transaction_types: ["confidential"] } },
    summary: ["Only confidential operations are allowed.", "Every operation waits for your approval, signed by alice.near, in Norr's Approvals tab."],
    call: { contractId: "outlayer.near", methodName: "store_wallet_policy", args: { wallet_pubkey: "ed25519:aa", encrypted_data: "x", wallet_signature: "y" }, gas: "100000000000000", deposit: "30890000000000000000000" },
    controller: "alice.near",
  };
  const setupVault = vi.fn(async () => ({ id: "v_abc", status: "setup", walletAccount: "a".repeat(64), createdAt: "", terms: { version: "2026-11-04", acceptedAt: "" }, nonUsConfirmed: false, custody: { prepared: false } }));

  it("shows the policy in words with the storage cost, has the owner's wallet sign it, and activates once the chain has it", async () => {
    const prepareCustody = vi.fn(async () => prepared);
    const activateVault = vi.fn().mockResolvedValueOnce({ status: "setup", problems: ["The policy is not on chain yet. Sign the transaction in your wallet, then check again."] }).mockResolvedValueOnce({ status: "active" });
    const send = vi.fn(async () => undefined);
    const navigate = vi.fn();
    const api = { setupVault, prepareCustody, activateVault } as unknown as Api;
    render(<SetupPage api={api} account="alice.near" id="v_abc" send={send} navigate={navigate} sleep={async () => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review the policy" }));
    expect(prepareCustody).toHaveBeenCalledWith("v_abc", false); // autonomous is off unless chosen
    expect(await screen.findByText(/waits for your approval/)).toBeTruthy();
    expect(screen.getByText("0.0309 NEAR")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign with your wallet" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("#/vault/v_abc/fund"));
    expect(send).toHaveBeenCalledWith(api, prepared.call, "alice.near");
    expect(activateVault).toHaveBeenCalledTimes(2);
  });

  it("autonomous mode is opt-in, and a failed check shows exactly what differs", async () => {
    const prepareCustody = vi.fn(async () => prepared);
    const activateVault = vi.fn(async () => ({ status: "setup", problems: ["The address whitelist differs."] }));
    const api = { setupVault, prepareCustody, activateVault } as unknown as Api;
    render(<SetupPage api={api} account="alice.near" id="v_abc" send={vi.fn(async () => undefined)} navigate={vi.fn()} sleep={async () => undefined} />);
    expect(await screen.findByText("OFF")).toBeTruthy(); // off until deliberately turned on
    fireEvent.click(await screen.findByLabelText("Turn autonomous mode on"));
    // A second, deliberate step: nothing is prepared until the owner says they understand.
    const review = screen.getByRole("button", { name: "Review the policy" }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I understand my agent's swaps will run without my approval/));
    fireEvent.click(review);
    expect(prepareCustody).toHaveBeenCalledWith("v_abc", true);
    expect((await screen.findByTestId("mode-line")).textContent).toMatch(/ON/);
    fireEvent.click(await screen.findByRole("button", { name: "Sign with your wallet" }));
    expect(await screen.findByText("The address whitelist differs.")).toBeTruthy();
    expect(activateVault).toHaveBeenCalledTimes(1); // only "not on chain yet" is worth waiting for
  });

  it("a wallet error is shown and nothing is checked", async () => {
    const activateVault = vi.fn();
    const api = { setupVault, prepareCustody: vi.fn(async () => prepared), activateVault } as unknown as Api;
    render(<SetupPage api={api} account="alice.near" id="v_abc" send={vi.fn(async () => { throw new Error("Your wallet is connected as bob.near, but this vault belongs to alice.near."); })} navigate={vi.fn()} sleep={async () => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review the policy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign with your wallet" }));
    expect(await screen.findByText(/connected as bob\.near/)).toBeTruthy();
    expect(activateVault).not.toHaveBeenCalled();
  });
});

describe("AuthorizePage (OAuth consent)", () => {
  it("names the app and where it returns, lets the owner pick one vault, and sends the browser back with the answer", async () => {
    const oauthApprove = vi.fn(async () => ({ redirect: "https://claude.ai/api/mcp/auth_callback?code=c&state=s" }));
    const go = vi.fn();
    const api = { oauthRequest: vi.fn(async () => ({ clientName: "Claude", redirectHost: "claude.ai", expiresAt: "", vaults: [{ id: "v_one", paused: false }, { id: "v_two", paused: true }] })), oauthApprove } as unknown as Api;
    render(<AuthorizePage api={api} account="alice.near" rid="r1" go={go} />);
    expect(await screen.findByText("Claude wants to trade for you")).toBeTruthy();
    expect(screen.getByText("claude.ai")).toBeTruthy();
    const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true); // two vaults: the owner must choose
    fireEvent.click(screen.getByLabelText(/v_one/));
    fireEvent.click(approve);
    await waitFor(() => expect(go).toHaveBeenCalledWith("https://claude.ai/api/mcp/auth_callback?code=c&state=s"));
    expect(oauthApprove).toHaveBeenCalledWith("r1", "v_one");
  });

  it("deny sends the browser back with the refusal; an expired request says so", async () => {
    const go = vi.fn();
    const api = { oauthRequest: vi.fn(async () => ({ clientName: "Claude", redirectHost: "claude.ai", expiresAt: "", vaults: [{ id: "v_one", paused: false }] })), oauthDeny: vi.fn(async () => ({ redirect: "https://claude.ai/cb?error=access_denied" })) } as unknown as Api;
    render(<AuthorizePage api={api} account="alice.near" rid="r1" go={go} />);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(go).toHaveBeenCalledWith("https://claude.ai/cb?error=access_denied"));
    cleanup();
    render(<AuthorizePage api={{ oauthRequest: vi.fn(async () => { throw new Error("This sign-in request has expired or was already used. Start again from your app."); }) } as unknown as Api} account="a" rid="r2" go={go} />);
    expect(await screen.findByText(/expired or was already used/)).toBeTruthy();
  });
});

describe("vault names in the dashboard", () => {
  it("NewVault sends the name; VaultTitle shows the name over the id and renames in place", async () => {
    const createVault = vi.fn(async () => ({ id: "v_abc" }));
    render(<NewVault api={{ createVault } as unknown as Api} account="alice.near" beta={beta} navigate={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Name it/), { target: { value: "Agent fund" } });
    fireEvent.click(screen.getByLabelText(/I have read and accept/));
    fireEvent.click(screen.getByRole("button", { name: "Create vault" }));
    await waitFor(() => expect(createVault).toHaveBeenCalledWith({ name: "Agent fund", acceptTerms: "2026-11-04", nonUsConfirmed: false }));
    cleanup();
    const renameVault = vi.fn(async () => ({ id: "v_abc", name: "Main" }));
    const onRenamed = vi.fn();
    render(<VaultTitle api={{ renameVault } as unknown as Api} vault={{ id: "v_abc", name: "Agent fund" }} onRenamed={onRenamed} />);
    expect(screen.getByRole("heading", { name: "Agent fund" })).toBeTruthy();
    expect(screen.getByText("v_abc")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Vault name"), { target: { value: "Main" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalled());
    expect(renameVault).toHaveBeenCalledWith("v_abc", "Main");
  });
});


describe("AutonomyPanel (Rules)", () => {
  const call = { contractId: "outlayer.near", methodName: "store_wallet_policy" as const, args: { wallet_pubkey: "ed25519:aa", encrypted_data: "x", wallet_signature: "y" }, gas: "100000000000000", deposit: "1000000000000000000000" };
  const prepared = { policy: {}, summary: ["Autonomous mode OFF: every swap waits for your approval in the Approvals tab.", "Only the approval exemption is removed from the stored policy; nothing else changes."], call, controller: "alice.near", autonomous: false };

  it("says ON in words, turns it off with one wallet signature, and reports it only after the service verified the change", async () => {
    const setCustodyMode = vi.fn(async () => prepared);
    const confirmCustodyMode = vi.fn().mockResolvedValueOnce({ status: "waiting", problems: ["Approvers or approval settings differ."] }).mockResolvedValueOnce({ status: "applied", autonomous: false });
    const send = vi.fn(async () => undefined);
    const onChanged = vi.fn();
    const api = { setCustodyMode, confirmCustodyMode } as unknown as Api;
    render(<AutonomyPanel api={api} vaultId="v_1" autonomous account="alice.near" send={send} sleep={async () => undefined} onChanged={onChanged} />);
    expect(screen.getByTestId("autonomy-state").textContent).toBe("ON");
    fireEvent.click(screen.getByRole("button", { name: "Turn autonomous mode off" })); // off needs no extra confirmation
    expect(await screen.findByText(/Autonomous mode OFF: every swap waits for your approval/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign with your wallet" }));
    expect(await screen.findByText("Autonomous mode is now OFF. Every swap waits for your approval.")).toBeTruthy();
    expect(send).toHaveBeenCalledWith(api, call, "alice.near");
    expect(confirmCustodyMode).toHaveBeenCalledTimes(2); // waited once for the chain, then it matched
    expect(onChanged).toHaveBeenCalled();
  });

  it("turning it ON needs the owner to say they understand before anything is prepared", async () => {
    const setCustodyMode = vi.fn(async () => ({ ...prepared, autonomous: true, summary: ["Autonomous mode ON: your agent's swaps run without your signature."] }));
    render(<AutonomyPanel api={{ setCustodyMode } as unknown as Api} vaultId="v_1" autonomous={false} account="alice.near" />);
    expect(screen.getByTestId("autonomy-state").textContent).toBe("OFF");
    const turnOn = screen.getByRole("button", { name: "Turn autonomous mode on" }) as HTMLButtonElement;
    expect(turnOn.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I understand my agent's swaps will run without my approval/));
    fireEvent.click(turnOn);
    await waitFor(() => expect(setCustodyMode).toHaveBeenCalledWith("v_1", true));
  });
});
