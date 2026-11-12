// @vitest-environment jsdom
/**
 * The wallet connection's hardening, against the real NEAR Connect library (only the network is replaced: the manifest is
 * passed in, and the wallets are never opened). What is claimed in nearconnect.ts and docs/FINDINGS.md is checked here.
 */
import { NearConnector } from "@hot-labs/near-connect";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CUSTOM_WALLETS_OFF, connectorOptions, forgetLegacySelectorKeys, guardedStorage, hasRememberedWallet, lockDown, makeKit, readCspNonce } from "./nearconnect";

const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../public/near-connect/manifest.json"), "utf8"));
const EVIL = { id: "evil", name: "Evil Wallet", icon: "data:,", description: "x", website: "https://evil.example", version: "1.0.0", executor: "https://evil.example/e.js", type: "sandbox", platform: {}, features: { signMessage: true, signInAndSignMessage: true }, permissions: { storage: true } };

const connector = (ls: Storage = localStorage) => lockDown(new NearConnector(connectorOptions(manifest, ls)));
const settle = () => new Promise((r) => setTimeout(r, 250));

beforeEach(() => localStorage.clear());
afterEach(() => document.head.querySelectorAll('meta[name="norr-csp-nonce"]').forEach((m) => m.remove()));

describe("the connector is configured for a dashboard that signs approvals", () => {
  it("offers exactly the pinned wallets that can sign a message, with one-step sign-in marked where the wallet has it", async () => {
    const kit = makeKit(connector());
    const offered = await kit.offered();
    expect(offered.map((w) => w.id).sort()).toEqual(manifest.wallets.map((w: { id: string }) => w.id).sort());
    expect(offered.find((w) => w.id === "hot-wallet")).toEqual({ id: "hot-wallet", name: "HOT Wallet", signsInOneStep: true });
    expect(offered.find((w) => w.id === "hana-wallet")?.signsInOneStep).toBe(false); // Hana connects first, then signs
    expect(offered.every((w) => w.name.length > 0)).toBe(true);
  });

  it("refuses to register a wallet from a pasted manifest, which is how the picker's settings panel adds one", async () => {
    const c = connector();
    await expect(c.registerDebugWallet(EVIL as never)).rejects.toThrow(CUSTOM_WALLETS_OFF);
    await settle();
    expect(c.wallets.some((w) => w.manifest.id === "evil")).toBe(false);
    expect((await makeKit(c).offered()).some((w) => w.id === "evil")).toBe(false);
  });

  it("ignores a custom wallet remembered from an earlier visit (the library stores them in localStorage under debug-wallets)", async () => {
    localStorage.setItem("debug-wallets", JSON.stringify([EVIL]));
    const c = connector();
    await settle();
    expect((await makeKit(c).offered()).some((w) => w.id === "evil")).toBe(false);
    expect(c.wallets.some((w) => w.manifest.id === "evil")).toBe(false);
  });

  it("does not sign in or register a wallet because some window posted it a message (the library's default auto-connect)", async () => {
    const c = connector();
    await settle();
    const signIns: unknown[] = [];
    c.on("wallet:signIn", (p) => signIns.push(p));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "near-wallet-injected", manifest: { ...EVIL, id: "evil-frame" } } }));
    await settle();
    expect(signIns).toEqual([]);
    expect(await localStorage.getItem("selected-wallet")).toBeNull();
  });

  it("a window that posts a wallet-injected message cannot replace a pinned wallet with one it controls (the library registers it, with no origin check)", async () => {
    const c = connector();
    const kit = makeKit(c);
    await settle();
    const spoof = () => window.dispatchEvent(new MessageEvent("message", { data: { type: "near-wallet-injected", manifest: { ...manifest.wallets[0], executor: "https://evil.example/e.js" } } }));
    spoof();
    await settle();
    // Positive control: without the kit, the library did replace the pinned HOT Wallet with a parent-frame wallet.
    const hot = () => c.wallets.find((w) => w.manifest.id === "hot-wallet")!;
    expect("callParentFrame" in hot()).toBe(true);
    // Through the kit it is stripped, and the real pinned wallet is back.
    const offered = await kit.offered();
    expect(offered.some((w) => w.id === "hot-wallet")).toBe(true);
    expect("callParentFrame" in hot()).toBe(false);
    expect(hot().manifest.executor).toBe(manifest.wallets[0].executor);
    expect(c.wallets.filter((w) => w.manifest.id === "hot-wallet")).toHaveLength(1);
    // The same, between a check and the use: the wallet that connect() returns is refused if it is the spoof.
    const spoofed = { ...c, connect: async () => {
      spoof();
      await settle(); // the library registers it asynchronously
      return c.wallets.find((w) => "callParentFrame" in w)!;
    }, wallets: c.wallets, registerWallet: c.registerWallet.bind(c), whenManifestLoaded: c.whenManifestLoaded, availableWallets: c.availableWallets, manifest: c.manifest, selectWallet: c.selectWallet.bind(c), getConnectedWallet: c.getConnectedWallet.bind(c), disconnect: c.disconnect.bind(c), on: c.on.bind(c), off: c.off.bind(c) };
    await expect(makeKit(spoofed as never).signIn("hot-wallet")).rejects.toThrow("did not come from Norr's wallet list");
  });

  it("a wallet id the picker returns that is not in the pinned manifest is refused before anything connects", async () => {
    const c = connector();
    const kit = makeKit({ ...c, selectWallet: async () => "evil", connect: c.connect.bind(c), wallets: c.wallets, registerWallet: c.registerWallet.bind(c), whenManifestLoaded: c.whenManifestLoaded, availableWallets: c.availableWallets, manifest: c.manifest, getConnectedWallet: c.getConnectedWallet.bind(c), disconnect: c.disconnect.bind(c), on: c.on.bind(c), off: c.off.bind(c) } as never);
    await expect(kit.select()).rejects.toThrow("That wallet is not one Norr offers");
    await expect(kit.signIn("evil")).rejects.toThrow("That wallet is not one Norr offers");
    await expect(kit.signInAndSign("evil", { message: "m", recipient: "r", nonce: new Uint8Array(32) })).rejects.toThrow("That wallet is not one Norr offers");
  });

  it("with no wallet connected, `connected` rejects instead of inventing one", async () => {
    await expect(makeKit(connector()).connected()).rejects.toThrow();
  });
});

describe("the connector's storage", () => {
  it("never reads or writes the remembered custom wallets key", async () => {
    const calls: string[] = [];
    const ls = { getItem: (k: string) => (calls.push(`get ${k}`), "[]"), setItem: (k: string) => void calls.push(`set ${k}`), removeItem: (k: string) => void calls.push(`remove ${k}`) };
    const s = guardedStorage(ls);
    expect(await s.get("debug-wallets")).toBeNull();
    await s.set("debug-wallets", "[{}]");
    expect(calls).toEqual([]);
    await s.set("selected-wallet", "hot-wallet");
    expect(await s.get("selected-wallet")).toBe("[]");
  });

  it("survives storage that throws (Safari private mode)", async () => {
    const boom = () => {
      throw new Error("denied");
    };
    const s = guardedStorage({ getItem: boom, setItem: boom, removeItem: boom });
    expect(await s.get("x")).toBeNull();
    await expect(s.set("x", "y")).resolves.toBeUndefined();
    await expect(s.remove("x")).resolves.toBeUndefined();
    expect(hasRememberedWallet({ getItem: boom })).toBe(false);
  });

  it("knows whether a wallet is remembered without loading the library", () => {
    expect(hasRememberedWallet()).toBe(false);
    localStorage.setItem("selected-wallet", "hot-wallet");
    expect(hasRememberedWallet()).toBe(true);
  });

  it("removes what the old wallet-selector left in the browser, and only that", () => {
    localStorage.setItem("near-wallet-selector:selectedWalletId", '"hot-wallet"');
    localStorage.setItem("near-wallet-selector:contract", "{}");
    localStorage.setItem("norr-flag", "1");
    forgetLegacySelectorKeys();
    expect(Object.keys(localStorage)).toEqual(["norr-flag"]);
  });
});

describe("the CSP nonce", () => {
  it("is read from the page's meta tag and handed to the connector, so its wallet frames can run under the CSP", () => {
    expect(readCspNonce()).toBeUndefined(); // local development has no CSP and no meta
    document.head.insertAdjacentHTML("beforeend", '<meta name="norr-csp-nonce" content="bf9z+U3q0igEb5X2YXgS9Q==">');
    expect(readCspNonce()).toBe("bf9z+U3q0igEb5X2YXgS9Q==");
    expect(connectorOptions(manifest).cspNonce).toBe("bf9z+U3q0igEb5X2YXgS9Q==");
  });

  it("the options turn off auto-connect and the NEAR Connect footer, and ask only for wallets that can sign messages", () => {
    const o = connectorOptions(manifest);
    expect(o.autoConnect).toBe(false);
    expect(o.footerBranding).toBeNull();
    expect(o.features).toEqual({ signMessage: true });
    expect(o.network).toBe("mainnet");
  });
});
