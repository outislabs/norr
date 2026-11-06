// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "./api";
import { disconnectWallet, walletSignIn, type SelectorKit } from "./signin";
import { missingWallets, walletFactories, WALLETS } from "./wallets";
import { buildCsp } from "./csp";

/** What the selector hands each factory: the network is always there in real use (MyNearWallet reads it at start). */
const ctx = { options: { network: { networkId: "mainnet", nodeUrl: "https://rpc.mainnet.near.org", helperUrl: "", explorerUrl: "", indexerUrl: "" }, debug: false } } as never;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

/** Importing every wallet package (Ledger's hardware libraries included) is slow while the whole suite runs in parallel. */
const HEAVY = 60_000;

describe("the wallet picker", () => {
  it("lists every configured wallet: a wallet that is configured but missing from the picker fails this test", async () => {
    const { setupWalletSelector } = await import("@near-wallet-selector/core");
    const { setupModal } = await import("@near-wallet-selector/modal-ui");
    const failures = new Map<string, unknown>();
    const selector = await setupWalletSelector({ network: "mainnet", modules: walletFactories((id, e) => failures.set(id, e)) });
    expect([...failures.keys()]).toEqual([]); // nothing failed to start
    expect(selector.store.getState().modules.map((m) => m.id).sort()).toEqual(WALLETS.map((w) => w.id).sort());
    expect(missingWallets(selector.store.getState().modules.map((m) => m.id), failures)).toEqual([]);

    // What the user sees: the modal's own wallet list.
    const modal = setupModal(selector, { theme: "dark" });
    modal.show();
    const list = () => [...document.querySelectorAll("#near-wallet-selector-modal li.single-wallet .title")].map((e) => e.textContent ?? "");
    // The modal renders asynchronously; wait for it instead of guessing how long (slow while the suite runs in parallel).
    for (let i = 0; i < 400 && list().length < WALLETS.length; i++) await new Promise((r) => setTimeout(r, 50));
    const shown = list();
    expect(shown.length).toBe(WALLETS.length);
    for (const w of WALLETS) expect(shown.some((t) => t.includes(w.name)), `${w.name} is in the picker`).toBe(true);
    modal.hide();
  }, HEAVY);

  it("marks the wallets we have not run with Norr as untested, and only those", () => {
    expect(WALLETS.filter((w) => w.tested).map((w) => w.id)).toEqual(["hot-wallet"]);
    expect(new Set(WALLETS.map((w) => w.id)).size).toBe(WALLETS.length);
    expect(WALLETS.map((w) => w.id)).toEqual(expect.arrayContaining(["hot-wallet", "meteor-wallet", "my-near-wallet", "intear-wallet", "nightly", "sender", "ledger"]));
  });

  it("names untested wallets '(untested)' in the picker, and leaves the tested one alone", async () => {
    const mods = await Promise.all(walletFactories().map((f) => f(ctx)));
    const names = Object.fromEntries(mods.map((m) => [m!.id, m!.metadata.name]));
    expect(names["hot-wallet"]).toBe("HOT Wallet");
    expect(names["nightly"]).toBe("Nightly (untested)");
    expect(names["ledger"]).toBe("Ledger (untested)");
  }, HEAVY);

  it("a wallet that fails to start is reported with its reason, not dropped silently", async () => {
    const real = WALLETS[1]!.load;
    WALLETS[1]!.load = async () => { throw new Error("storage is blocked"); };
    try {
      const failures = new Map<string, unknown>();
      const settled = await Promise.allSettled(walletFactories((id, e) => failures.set(id, e)).map((f) => f(ctx)));
      expect(settled.filter((s) => s.status === "rejected")).toHaveLength(1);
      const registered = WALLETS.filter((w) => w.id !== WALLETS[1]!.id).map((w) => w.id);
      expect(missingWallets(registered, failures)).toEqual([{ id: WALLETS[1]!.id, name: WALLETS[1]!.name, reason: "storage is blocked" }]);
    } finally {
      WALLETS[1]!.load = real;
    }
  });
});

/** A selector kit with a remembered wallet, to see whether the picker still appears. */
function rememberedKit(opts: { missing?: SelectorKit["missing"] } = {}) {
  let accounts: { accountId: string }[] = [{ accountId: "legalalienx.near" }];
  const subs: ((s: { accounts: unknown[] }) => void)[] = [];
  const signOut = vi.fn(async () => { accounts = []; });
  const signMessage = vi.fn(async () => ({ accountId: "owner.near", publicKey: "ed25519:K", signature: "sig" }));
  const modalShown = vi.fn();
  const kit = {
    selector: {
      store: { getState: () => ({ accounts }), observable: { subscribe: (f: (s: { accounts: unknown[] }) => void) => (subs.push(f), { unsubscribe() {} }) } },
      wallet: async () => ({ metadata: { name: "Any" }, signOut, signMessage }),
    },
    // The real modal waits for a click: the wallet connects some time after it opens, not at once.
    setupModal: () => ({ show: () => { modalShown(); setTimeout(() => { accounts = [{ accountId: "owner.near" }]; subs.forEach((f) => f({ accounts })); }, 5); }, on: () => undefined }),
    missing: opts.missing ?? [],
  } as unknown as SelectorKit;
  return { kit, signOut, modalShown, signMessage };
}
const api = { challenge: async () => ({ nonce: Buffer.alloc(32).toString("base64"), message: "m", recipient: "app.norr.finance", expiresAt: 0 }), login: async (b: unknown) => ({ token: "t", accountId: (b as { accountId: string }).accountId, expiresAt: 1 }) } as unknown as Api;

describe("a remembered wallet never replaces the picker (seen live 2026-11-06: after one HOT sign-in, HOT was the only choice)", () => {
  it("disconnects the remembered wallet and shows the picker before signing in", async () => {
    const { kit, signOut, modalShown } = rememberedKit();
    const session = await walletSignIn(api, { load: async () => kit });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(modalShown).toHaveBeenCalledTimes(1);
    expect(session.accountId).toBe("owner.near");
  });

  it("says which wallets did not start in this browser", async () => {
    const { kit } = rememberedKit({ missing: [{ id: "meteor-wallet", name: "Meteor Wallet", reason: "storage is blocked" }] });
    const onNotice = vi.fn();
    await walletSignIn(api, { load: async () => kit, onNotice });
    expect(onNotice).toHaveBeenCalledWith("Not available in this browser: Meteor Wallet (storage is blocked).");
  });

  it("signing out forgets the wallet; with nothing remembered it does not even load the selector", async () => {
    const { kit, signOut } = rememberedKit();
    const load = vi.fn(async () => kit);
    await disconnectWallet(load);
    expect(load).not.toHaveBeenCalled(); // nothing remembered in localStorage
    localStorage.setItem("near-wallet-selector:selectedWalletId", JSON.stringify("hot-wallet"));
    await disconnectWallet(load);
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe("CSP origins for the configured wallets", () => {
  it("allows exactly Intear's logout bridge beyond the earlier origins, and nothing for the extensions and the hardware wallet", () => {
    const csp = buildCsp("https://api.norr.finance");
    expect(csp).toContain("https://logout-bridge-service.intear.tech");
    expect(csp).toContain("wss://logout-bridge-service.intear.tech");
    for (const host of ["nightly.app", "sender", "ledger"]) expect(csp).not.toContain(host);
    expect(csp).not.toMatch(/script-src[^;]*https?:\/\//); // still no third-party scripts
  });
});
