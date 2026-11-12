import type { Api, Challenge, DirectDeposit, PolicyStoreCall, SessionInfo } from "./api";
import { hasRememberedWallet, loadKit, type Kit, type SignedMessage, type WalletHandle } from "./nearconnect";
import { base64ToBytes, generateDemoKey, type DemoKey } from "./nep413";
import { describeFailure, failureText, isWalletNetworkError, SignInError, watchCspViolations, withRetry, type RetryOptions, type SignInStep } from "./resilience";
import { UNLOCK_MESSAGE, UNLOCK_NONCE, UNLOCK_RECIPIENT } from "./seal";
import { normalizeSignature } from "./signature";

/** Mock mode only: sign in as the demo owner with a throwaway browser key. The mock service accepts any key. */
let demoKey: DemoKey | null = null;
export async function demoSignIn(api: Api, owner: string): Promise<SessionInfo> {
  const key = (demoKey = await generateDemoKey());
  const c = await api.challenge();
  const signature = await key.sign({ message: c.message, nonce: base64ToBytes(c.nonce), recipient: c.recipient });
  return api.login({ accountId: owner, publicKey: key.publicKey, signature, nonce: c.nonce });
}

/** Forget the connected wallet (on sign-out), so the next sign-in shows the whole picker. Loads the library only if a wallet is remembered. */
export async function disconnectWallet(load: () => Promise<Kit> = loadKit): Promise<void> {
  if (!hasRememberedWallet()) return;
  try {
    await (await load()).disconnect();
  } catch {
    /* nothing to disconnect */
  }
}

const NOT_CONNECTED = "Your wallet is not connected. Sign in again.";

async function connectedWallet(load: () => Promise<Kit>): Promise<{ wallet: WalletHandle; accounts: { accountId: string }[] }> {
  const kit = await load();
  try {
    return await kit.connected();
  } catch {
    throw new Error(NOT_CONNECTED);
  }
}

/**
 * Ask the wallet for a message signature, trying again when the connection drops. A signature changes nothing on chain
 * and Norr only acts on the one it receives, so asking twice is harmless (at worst the owner is prompted twice). The
 * drop is typically the page having been suspended while the owner was in the wallet app (iOS Safari).
 */
async function signRetrying(wallet: WalletHandle, m: { message: string; recipient: string; nonce: Uint8Array }, retry?: RetryOptions): Promise<SignedMessage> {
  try {
    return await withRetry(() => wallet.signMessage(m), { ...retry, retryable: isWalletNetworkError });
  } catch (e) {
    throw new Error(describeFailure(e, isWalletNetworkError(e)));
  }
}

/** The wallet's signature as the standard base64 the service and OutLayer take. */
const sigOf = (s: SignedMessage): string => normalizeSignature(s.signature);

/**
 * Send a transaction from the owner's wallet. Never retried: a dropped connection can come after the wallet sent it, and
 * sending twice is not harmless. The message says so instead.
 */
async function sendTransaction(wallet: WalletHandle, owner: string, receiverId: string, methodName: string, args: object, gas: string, deposit: string): Promise<void> {
  try {
    await wallet.signAndSendTransaction({ signerId: owner, receiverId, actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }] });
  } catch (e) {
    if (isWalletNetworkError(e)) {
      throw new Error(`The connection dropped while ${wallet.name} was working (${failureText(e)}). The transaction may already have gone through: check ${wallet.name}'s activity before trying again.`);
    }
    throw new Error(failureText(e));
  }
}

const CLOSED = "Wallet connection was closed.";

/**
 * Real sign-in: the owner's NEAR wallet signs the service's challenge (NEP-413), in the wallet picker NEAR Connect offers.
 *
 * - One wallet interaction where the wallet allows it (`signInAndSignMessage`: HOT, Meteor and MyNearWallet do): the
 *   challenge is fetched when the owner has chosen the wallet, and the wallet signs in and signs in one go. That is one
 *   popup or app switch instead of two, which matters on a phone. A wallet that cannot do both connects first, then signs.
 * - Every step has its own error text (which step, and what went wrong), and a dropped connection is retried after the
 *   page is visible again: Norr's own requests always, a wallet's signature prompt too (harmless to repeat). Verification
 *   is retried as well; the challenge is single-use, so if the first try had in fact arrived, the retry is refused and the
 *   message says to sign in again.
 * - The picker always shows: a remembered wallet never replaces it.
 */
export async function walletSignIn(api: Api, o: { onNotice?: (message: string) => void; load?: () => Promise<Kit>; retry?: RetryOptions } = {}): Promise<SessionInfo> {
  const csp = watchCspViolations();
  try {
    return await signInSteps(api, o);
  } catch (e) {
    // A blocked origin is the one thing a retry never fixes: name it.
    const blocked = csp.blocked();
    if (blocked.length > 0) throw new Error(`${e instanceof Error ? e.message : String(e)} The browser blocked: ${blocked.join(", ")}.`);
    throw e;
  } finally {
    csp.stop();
  }
}

async function signInSteps(api: Api, o: { onNotice?: (message: string) => void; load?: () => Promise<Kit>; retry?: RetryOptions }): Promise<SessionInfo> {
  /** Run one named step. `retryable` says which failures are tried again (default: none). */
  const step = async <T>(name: SignInStep, fn: () => Promise<T>, retryable?: (e: unknown) => boolean): Promise<T> => {
    let tries = 0;
    try {
      return retryable ? await withRetry(() => (tries++, fn()), { ...o.retry, retryable }) : await fn();
    } catch (e) {
      if (e instanceof SignInError) throw e;
      throw new SignInError(name, describeFailure(e, tries > 1), e);
    }
  };
  const asNetwork = isWalletNetworkError;

  const kit = await step("connect", () => (o.load ?? loadKit)());
  const offered = await kit.offered();
  if (offered.length === 0) throw new SignInError("connect", "the list of wallets did not load. Check your connection and reload the page.");

  let id: string;
  try {
    id = await kit.select();
  } catch (e) {
    throw new Error(/reject|clos|cancel/i.test(failureText(e)) ? CLOSED : failureText(e));
  }
  const chosen = offered.find((w) => w.id === id);
  if (!chosen) throw new SignInError("connect", "that wallet is not one Norr offers. Choose one from the list.");

  const nonceOf = (c: Challenge) => base64ToBytes(c.nonce);
  let c: Challenge;
  let signed: SignedMessage;
  if (chosen.signsInOneStep) {
    c = await step("challenge", () => api.challenge(), asNetwork);
    const ch = c;
    signed = (await step("sign", () => kit.signInAndSign(id, { message: ch.message, recipient: ch.recipient, nonce: nonceOf(ch) }), asNetwork)).signed;
  } else {
    const { wallet } = await step("connect", () => kit.signIn(id), asNetwork);
    c = await step("challenge", () => api.challenge(), asNetwork);
    const ch = c;
    signed = await step("sign", () => wallet.signMessage({ message: ch.message, recipient: ch.recipient, nonce: nonceOf(ch) }), asNetwork);
  }
  const signature = await step("sign", async () => sigOf(signed));

  let dropped = false;
  try {
    return await withRetry(
      async () => {
        try {
          return await api.login({ accountId: signed.accountId, publicKey: signed.publicKey, signature, nonce: c.nonce });
        } catch (e) {
          if (isWalletNetworkError(e)) dropped = true;
          throw e;
        }
      },
      o.retry,
    );
  } catch (e) {
    if (dropped && !isWalletNetworkError(e)) throw new SignInError("verify", "the connection dropped, and Norr had already used this sign-in challenge. Sign in again (one more signature).", e);
    throw new SignInError("verify", describeFailure(e, dropped), e);
  }
}

/**
 * Sign the fixed unlock message, from which the key for the private reasoning is derived. In mock mode the
 * demo sign-in key signs it; otherwise the connected wallet does (one prompt, no transaction).
 */
export async function signUnlock(load: () => Promise<Kit> = loadKit): Promise<Uint8Array> {
  const m = { message: UNLOCK_MESSAGE, nonce: UNLOCK_NONCE, recipient: UNLOCK_RECIPIENT };
  if (demoKey) return base64ToBytes(await demoKey.sign(m));
  const { wallet } = await connectedWallet(load);
  return base64ToBytes(sigOf(await signRetrying(wallet, m)));
}

/**
 * Sign an approval vote for the custody provider: NEP-413 over the exact message it asks for
 * ("approve|reject:{approval_id}:{wallet_pubkey}:{request_hash}"), for its recipient. In mock mode the demo key signs;
 * otherwise the connected wallet does (one prompt, no transaction). The vote is sent by the caller, not by Norr.
 */
export async function signVote(message: string, recipient: string, nonce: Uint8Array, owner: string, load: () => Promise<Kit> = loadKit): Promise<{ signature: string; publicKey: string; accountId: string }> {
  if (demoKey) return { signature: await demoKey.sign({ message, nonce, recipient }), publicKey: demoKey.publicKey, accountId: owner };
  const { wallet } = await connectedWallet(load);
  const signed = await signRetrying(wallet, { message, recipient, nonce });
  return { signature: sigOf(signed), publicKey: signed.publicKey, accountId: signed.accountId };
}

/**
 * Store the vault's custody policy on chain from the owner's own wallet: one transaction to the policy contract
 * (`store_wallet_policy`), with the storage deposit shown before signing. Sent by the owner, so the owner becomes the
 * wallet's controller and Norr can never change the policy. In mock mode the signed-in session stands in for the wallet.
 */
export async function sendPolicyStore(api: Api, call: PolicyStoreCall, owner: string, load: () => Promise<Kit> = loadKit): Promise<void> {
  if (demoKey) {
    await api.mockStorePolicy(call.args);
    return;
  }
  const { wallet, accounts } = await connectedWallet(load);
  if (!accounts.some((a) => a.accountId === owner)) {
    throw new Error(`Your wallet is connected as ${accounts[0]?.accountId ?? "nobody"}, but this vault belongs to ${owner}. Switch accounts in your wallet and try again.`);
  }
  await sendTransaction(wallet, owner, call.contractId, call.methodName, call.args, call.gas, call.deposit);
}

/**
 * Pay the vault directly on NEAR (when 1Click cannot quote): `ft_transfer_call` on the token contract to `intents.near`,
 * crediting the vault's own account (msg). Any connected NEAR account may send it. Returns the account that sent.
 * In mock mode the session stands in for the wallet.
 */
export async function sendDirectDeposit(api: Api, d: DirectDeposit, load: () => Promise<Kit> = loadKit): Promise<string> {
  if (demoKey) {
    await api.mockDirectDeposit(d.args);
    return "demo wallet";
  }
  const { wallet, accounts } = await connectedWallet(load);
  const signer = accounts[0]?.accountId;
  if (!signer) throw new Error(NOT_CONNECTED);
  await sendTransaction(wallet, signer, d.contractId, d.methodName, d.args, d.gas, d.deposit);
  return signer;
}
