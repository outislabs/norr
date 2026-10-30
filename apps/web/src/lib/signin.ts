import { Buffer } from "buffer";
import type { Api, SessionInfo } from "./api";
import { base64ToBytes, generateDemoKey } from "./nep413";

/** Mock mode only: sign in as the demo owner with a throwaway browser key. The mock service accepts any key. */
export async function demoSignIn(api: Api, owner: string): Promise<SessionInfo> {
  const key = await generateDemoKey();
  const c = await api.challenge();
  const signature = await key.sign({ message: c.message, nonce: base64ToBytes(c.nonce), recipient: c.recipient });
  return api.login({ accountId: owner, publicKey: key.publicKey, signature, nonce: c.nonce });
}

/**
 * Real sign-in: the user's NEAR wallet signs the server's challenge (NEP-413). The wallet selector is
 * loaded on demand. NOTE: this path has not been exercised against a real wallet yet; the demo path
 * and the server-side verification are tested.
 */
export async function walletSignIn(api: Api): Promise<SessionInfo> {
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
  if (selector.store.getState().accounts.length === 0) {
    const modal = setupModal(selector, {});
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
