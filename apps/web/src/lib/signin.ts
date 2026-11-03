import { Buffer } from "buffer";
import type { Api, SessionInfo } from "./api";
import { base64ToBytes, generateDemoKey, type DemoKey } from "./nep413";
import { UNLOCK_MESSAGE, UNLOCK_NONCE, UNLOCK_RECIPIENT } from "./seal";

/** Mock mode only: sign in as the demo owner with a throwaway browser key. The mock service accepts any key. */
let demoKey: DemoKey | null = null;
export async function demoSignIn(api: Api, owner: string): Promise<SessionInfo> {
  const key = (demoKey = await generateDemoKey());
  const c = await api.challenge();
  const signature = await key.sign({ message: c.message, nonce: base64ToBytes(c.nonce), recipient: c.recipient });
  return api.login({ accountId: owner, publicKey: key.publicKey, signature, nonce: c.nonce });
}

/** The wallet selector with the wallets Norr supports. Loaded on demand. */
async function loadSelector() {
  (globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
  const [{ setupWalletSelector }, { setupModal }, { setupMeteorWallet }, { setupMyNearWallet }, { setupHotWallet }] = await Promise.all([
    import("@near-wallet-selector/core"),
    import("@near-wallet-selector/modal-ui"),
    import("@near-wallet-selector/meteor-wallet"),
    import("@near-wallet-selector/my-near-wallet"),
    import("@near-wallet-selector/hot-wallet"),
  ]);
  await import("@near-wallet-selector/modal-ui/styles.css");
  const selector = await setupWalletSelector({ network: "mainnet", modules: [setupHotWallet(), setupMeteorWallet(), setupMyNearWallet()] });
  return { selector, setupModal };
}

/**
 * Real sign-in: the user's NEAR wallet signs the server's challenge (NEP-413). Verified in Safari with HOT
 * Wallet; the server-side verification is covered by tests.
 */
export async function walletSignIn(api: Api): Promise<SessionInfo> {
  const { selector, setupModal } = await loadSelector();
  if (selector.store.getState().accounts.length === 0) {
    const modal = setupModal(selector, { theme: "dark" });
    modal.show();
    await new Promise<void>((resolve, reject) => {
      const sub = selector.store.observable.subscribe((s) => {
        if (s.accounts.length > 0) {
          sub.unsubscribe();
          resolve();
        }
      });
      modal.on("onHide", () => {
        if (selector.store.getState().accounts.length === 0) {
          sub.unsubscribe();
          reject(new Error("Wallet connection was closed."));
        }
      });
    });
  }
  const wallet = await selector.wallet();
  if (!wallet.signMessage) throw new Error("This wallet cannot sign messages. Try another wallet.");
  const c = await api.challenge();
  const signed = await wallet.signMessage({ message: c.message, recipient: c.recipient, nonce: Buffer.from(c.nonce, "base64") });
  if (!signed) throw new Error("The wallet did not return a signature.");
  return api.login({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: c.nonce });
}

/**
 * Sign the fixed unlock message, from which the key for the private reasoning is derived. In mock mode the
 * demo sign-in key signs it; otherwise the connected wallet does (one prompt, no transaction).
 */
export async function signUnlock(): Promise<Uint8Array> {
  const m = { message: UNLOCK_MESSAGE, nonce: UNLOCK_NONCE, recipient: UNLOCK_RECIPIENT };
  if (demoKey) return base64ToBytes(await demoKey.sign(m));
  const { selector } = await loadSelector();
  if (selector.store.getState().accounts.length === 0) throw new Error("Your wallet is not connected. Sign in again.");
  const wallet = await selector.wallet();
  if (!wallet.signMessage) throw new Error("This wallet cannot sign messages. Try another wallet.");
  const signed = await wallet.signMessage({ message: m.message, recipient: m.recipient, nonce: Buffer.from(m.nonce) });
  if (!signed) throw new Error("The wallet did not return a signature.");
  return base64ToBytes(signed.signature);
}
