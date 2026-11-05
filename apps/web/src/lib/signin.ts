import { Buffer } from "buffer";
import type { Api, DirectDeposit, PolicyStoreCall, SessionInfo } from "./api";
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

/**
 * Sign an approval vote for the custody provider: NEP-413 over the exact message it asks for
 * ("approve|reject:{approval_id}:{wallet_pubkey}:{request_hash}"), for its recipient. In mock mode the demo key signs;
 * otherwise the connected wallet does (one prompt, no transaction). The vote is sent by the caller, not by Norr.
 */
export async function signVote(message: string, recipient: string, nonce: Uint8Array, owner: string): Promise<{ signature: string; publicKey: string; accountId: string }> {
  if (demoKey) return { signature: await demoKey.sign({ message, nonce, recipient }), publicKey: demoKey.publicKey, accountId: owner };
  const { selector } = await loadSelector();
  if (selector.store.getState().accounts.length === 0) throw new Error("Your wallet is not connected. Sign in again.");
  const wallet = await selector.wallet();
  if (!wallet.signMessage) throw new Error("This wallet cannot sign messages. Try another wallet.");
  const signed = await wallet.signMessage({ message, recipient, nonce: Buffer.from(nonce) });
  if (!signed) throw new Error("The wallet did not return a signature.");
  return { signature: signed.signature, publicKey: signed.publicKey, accountId: signed.accountId };
}

/**
 * Store the vault's custody policy on chain from the owner's own wallet: one transaction to the policy contract
 * (`store_wallet_policy`), with the storage deposit shown before signing. Sent by the owner, so the owner becomes the
 * wallet's controller and Norr can never change the policy. In mock mode the signed-in session stands in for the wallet.
 */
export async function sendPolicyStore(api: Api, call: PolicyStoreCall, owner: string): Promise<void> {
  if (demoKey) {
    await api.mockStorePolicy(call.args);
    return;
  }
  const { selector } = await loadSelector();
  if (selector.store.getState().accounts.length === 0) throw new Error("Your wallet is not connected. Sign in again.");
  const wallet = await selector.wallet();
  const signer = selector.store.getState().accounts.find((a) => a.active)?.accountId ?? selector.store.getState().accounts[0]?.accountId;
  if (signer !== owner) throw new Error(`Your wallet is connected as ${signer ?? "nobody"}, but this vault belongs to ${owner}. Switch accounts in your wallet and try again.`);
  const { actionCreators } = await import("@near-js/transactions");
  await wallet.signAndSendTransaction({
    signerId: owner,
    receiverId: call.contractId,
    actions: [actionCreators.functionCall(call.methodName, call.args, BigInt(call.gas), BigInt(call.deposit))],
  });
}

/**
 * Pay the vault directly on NEAR (when 1Click cannot quote): `ft_transfer_call` on the token contract to `intents.near`,
 * crediting the vault's own account (msg). Any connected NEAR account may send it. Returns the account that sent.
 * In mock mode the session stands in for the wallet.
 */
export async function sendDirectDeposit(api: Api, d: DirectDeposit): Promise<string> {
  if (demoKey) {
    await api.mockDirectDeposit(d.args);
    return "demo wallet";
  }
  const { selector } = await loadSelector();
  if (selector.store.getState().accounts.length === 0) throw new Error("Your wallet is not connected. Sign in again.");
  const wallet = await selector.wallet();
  const signer = selector.store.getState().accounts.find((a) => a.active)?.accountId ?? selector.store.getState().accounts[0]!.accountId;
  const { actionCreators } = await import("@near-js/transactions");
  await wallet.signAndSendTransaction({
    signerId: signer,
    receiverId: d.contractId,
    actions: [actionCreators.functionCall(d.methodName, d.args, BigInt(d.gas), BigInt(d.deposit))],
  });
  return signer;
}
