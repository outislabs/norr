// @vitest-environment jsdom
/**
 * Sign-in, approval signing and the policy transaction, through the wallet kit (NEAR Connect) with a fake wallet.
 *
 * The mobile Safari scenarios are the ones seen live (2026-11-11, iPhone: "Failed to sign in with HOT Wallet: Load
 * failed", gone on a manual retry): on a phone the owner leaves the page for the wallet app and comes back, Safari suspends
 * the page meanwhile, and a request in flight, or the first one on a stale connection, dies with `TypeError: Load failed`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi, type Api, type PolicyStoreCall } from "./api";
import type { Kit, SignedMessage, WalletHandle } from "./nearconnect";
import { base58Encode, base64ToBytes, bytesToBase64 } from "./nep413";
import { SignInError } from "./resilience";
import { UNLOCK_MESSAGE, UNLOCK_NONCE, UNLOCK_RECIPIENT } from "./seal";
import { disconnectWallet, sendDirectDeposit, sendPolicyStore, signUnlock, signVote, walletSignIn } from "./signin";

const noWait = { sleep: async () => {} };
const loadFailed = () => new TypeError("Load failed"); // Safari's text for a dropped fetch
const SIG = new Uint8Array(64).fill(5);
const SIG_B64 = bytesToBase64(SIG);
const signed = (over: Partial<SignedMessage> = {}): SignedMessage => ({ accountId: "owner.near", publicKey: "ed25519:K", signature: SIG_B64, ...over });
const challenge = { nonce: bytesToBase64(new Uint8Array(32).fill(9)), message: "Sign in to Norr at https://app.norr.finance", recipient: "app.norr.finance", expiresAt: 0 };

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

/** iOS switches to the wallet app, then back. */
const leaveForWallet = () => {
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
};
const comeBack = () => {
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The real API client over a scripted fetch: each entry answers one request, in order. */
function scriptedApi(script: (() => Response | Promise<Response>)[]) {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = script.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return next();
  });
  return { api: createApi({ base: "https://api.norr.finance", getToken: () => null, onUnauthorized: () => {}, fetch }) as Api, calls };
}
const json = (b: unknown, status = 200) => () => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const drop = () => () => {
  throw loadFailed();
};
const session = json({ token: "t", accountId: "owner.near", expiresAt: 1 });

interface FakeOpts {
  /** A wallet that can sign in and sign in one interaction (HOT, Meteor, MyNearWallet) or not (Hana). */
  oneStep?: boolean;
  select?: () => Promise<string>;
  offered?: { id: string; name: string; signsInOneStep: boolean }[];
  signInAndSign?: Kit["signInAndSign"];
  signMessage?: WalletHandle["signMessage"];
  signAndSendTransaction?: WalletHandle["signAndSendTransaction"];
  accounts?: { accountId: string }[];
  connected?: Kit["connected"];
}
/** A fake wallet kit that records the order of what the sign-in asks of it. */
function fakeKit(o: FakeOpts = {}) {
  const order: string[] = [];
  const oneStep = o.oneStep ?? true;
  const wallet: WalletHandle = {
    id: oneStep ? "hot-wallet" : "hana-wallet",
    name: oneStep ? "HOT Wallet" : "Hana Wallet",
    signMessage: vi.fn(o.signMessage ?? (async () => (order.push("signMessage"), signed()))),
    signAndSendTransaction: vi.fn(o.signAndSendTransaction ?? (async () => undefined)),
  };
  const accounts = o.accounts ?? [{ accountId: "owner.near" }];
  const kit: Kit = {
    offered: async () => o.offered ?? [{ id: wallet.id, name: wallet.name, signsInOneStep: oneStep }],
    select: vi.fn(o.select ?? (async () => (order.push("select"), wallet.id))),
    signIn: vi.fn(async () => (order.push("signIn"), { wallet, accounts })),
    signInAndSign: vi.fn(o.signInAndSign ?? (async () => (order.push("signInAndSign"), { wallet, signed: signed() }))),
    connected: vi.fn(o.connected ?? (async () => ({ wallet, accounts }))),
    disconnect: vi.fn(async () => undefined),
  };
  return { kit, wallet, order, load: async () => kit };
}

describe("sign-in with a wallet that can sign in and sign in one interaction", () => {
  it("fetches the challenge once the wallet is chosen, then one wallet interaction signs it, then Norr verifies", async () => {
    const f = fakeKit();
    const { api, calls } = scriptedApi([json(challenge), session]);
    f.kit.select = vi.fn(async () => (f.order.push("select"), f.wallet.id));
    const origChallenge = api.challenge;
    api.challenge = async () => (f.order.push("challenge"), origChallenge());
    expect((await walletSignIn(api, { load: f.load, retry: noWait })).accountId).toBe("owner.near");
    expect(f.order).toEqual(["select", "challenge", "signInAndSign"]);
    expect(f.kit.signIn).not.toHaveBeenCalled(); // one interaction, not two
    const args = vi.mocked(f.kit.signInAndSign).mock.calls[0]!;
    expect(args[0]).toBe("hot-wallet");
    expect(args[1].message).toBe(challenge.message);
    expect(args[1].recipient).toBe("app.norr.finance");
    expect(Array.from(args[1].nonce)).toEqual(Array.from(base64ToBytes(challenge.nonce)));
    expect(calls.map((c) => c.path)).toEqual(["/owner/v1/challenge", "/owner/v1/login"]);
    expect(calls[1]!.body).toEqual({ accountId: "owner.near", publicKey: "ed25519:K", signature: SIG_B64, nonce: challenge.nonce });
  });

  it("hands Norr the standard base64 whichever text the wallet signed with (ed25519:<base58> here)", async () => {
    const f = fakeKit({ signInAndSign: async () => ({ wallet: fakeKit().wallet, signed: signed({ signature: `ed25519:${base58Encode(SIG)}` }) }) });
    const { api, calls } = scriptedApi([json(challenge), session]);
    await walletSignIn(api, { load: f.load, retry: noWait });
    expect(calls[1]!.body!.signature).toBe(SIG_B64);
  });
});

describe("sign-in with a wallet that must connect first (Hana)", () => {
  it("connects, then fetches the challenge, then signs it", async () => {
    const f = fakeKit({ oneStep: false });
    const { api, calls } = scriptedApi([json(challenge), session]);
    await walletSignIn(api, { load: f.load, retry: noWait });
    expect(f.order).toEqual(["select", "signIn", "signMessage"]);
    expect(f.kit.signInAndSign).not.toHaveBeenCalled();
    expect(calls.map((c) => c.path)).toEqual(["/owner/v1/challenge", "/owner/v1/login"]);
  });
});

describe("the picker and the wallet list", () => {
  it("closing the picker says so, in the words the page has always used", async () => {
    const f = fakeKit({ select: async () => Promise.reject(new Error("User rejected")) });
    const { api, calls } = scriptedApi([]);
    await expect(walletSignIn(api, { load: f.load, retry: noWait })).rejects.toThrow("Wallet connection was closed.");
    expect(calls).toHaveLength(0); // no challenge was asked for
  });

  it("a wallet list that did not load is a connect-step failure with advice, not a silent empty picker", async () => {
    const f = fakeKit({ offered: [] });
    const e = await walletSignIn(scriptedApi([]).api, { load: f.load, retry: noWait }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SignInError);
    expect((e as SignInError).step).toBe("connect");
    expect((e as Error).message).toBe("Sign-in failed while connecting to your wallet: the list of wallets did not load. Check your connection and reload the page.");
  });

  it("the library failing to load is named as the connect step", async () => {
    const e = await walletSignIn(scriptedApi([]).api, { load: async () => Promise.reject(new Error("chunk failed")), retry: noWait }).catch((x: unknown) => x);
    expect((e as Error).message).toBe("Sign-in failed while connecting to your wallet: chunk failed");
  });

  it("a wallet the picker returns that Norr does not offer is refused before anything is signed", async () => {
    const f = fakeKit({ select: async () => "injected-by-a-page" });
    const { api, calls } = scriptedApi([]);
    const e = await walletSignIn(api, { load: f.load, retry: noWait }).catch((x: unknown) => x);
    expect((e as Error).message).toContain("that wallet is not one Norr offers");
    expect(f.kit.signInAndSign).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe("mobile Safari: the page is suspended while the owner is in the wallet app", () => {
  it("a dropped challenge request is retried, and sign-in completes", async () => {
    const f = fakeKit();
    const { api, calls } = scriptedApi([drop(), json(challenge), session]);
    expect((await walletSignIn(api, { load: f.load, retry: noWait })).accountId).toBe("owner.near");
    expect(calls.map((c) => c.path)).toEqual(["/owner/v1/challenge", "/owner/v1/challenge", "/owner/v1/login"]);
  });

  it("the app switch: verify waits until the owner is back on the page, survives a dropped first try, and completes", async () => {
    const f = fakeKit({ signInAndSign: async () => (leaveForWallet(), { wallet: fakeKit().wallet, signed: signed() }) });
    const { api, calls } = scriptedApi([json(challenge), drop(), session]);
    const p = walletSignIn(api, { load: f.load, retry: noWait });
    for (let i = 0; i < 20; i++) await tick();
    expect(calls.map((c) => c.path)).toEqual(["/owner/v1/challenge"]); // verify not sent while suspended
    comeBack();
    expect((await p).accountId).toBe("owner.near");
    expect(calls.map((c) => c.path)).toEqual(["/owner/v1/challenge", "/owner/v1/login", "/owner/v1/login"]);
  });

  it("the wallet's own connection dropping (an error that crossed the wallet's sandbox as a plain Error) is retried", async () => {
    let n = 0;
    const f = fakeKit({ signInAndSign: async () => (n++ === 0 ? Promise.reject(new Error("Load failed")) : { wallet: fakeKit().wallet, signed: signed() }) });
    const { api } = scriptedApi([json(challenge), session]);
    await walletSignIn(api, { load: f.load, retry: noWait });
    expect(n).toBe(2);
  });

  it("the same, when the sandbox hands the failure back as a bare string", async () => {
    let n = 0;
    const f = fakeKit({ signInAndSign: async () => (n++ === 0 ? Promise.reject("Failed to fetch") : { wallet: fakeKit().wallet, signed: signed() }) });
    await walletSignIn(scriptedApi([json(challenge), session]).api, { load: f.load, retry: noWait });
    expect(n).toBe(2);
  });

  it("verify dropped after it reached Norr: the retry is refused (single-use challenge) and the message says to sign in again", async () => {
    const f = fakeKit();
    const { api } = scriptedApi([json(challenge), drop(), json({ error: "Invalid or expired challenge" }, 401)]);
    const e = await walletSignIn(api, { load: f.load, retry: noWait }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SignInError);
    expect((e as SignInError).step).toBe("verify");
    expect((e as Error).message).toMatch(/checking the signature with Norr/);
    expect((e as Error).message).toMatch(/Sign in again/);
  });
});

describe("each failure names its step", () => {
  it("Norr unreachable throughout: the challenge step", async () => {
    const e = await walletSignIn(scriptedApi([drop(), drop(), drop()]).api, { load: fakeKit().load, retry: noWait }).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/^Sign-in failed while getting a sign-in challenge from Norr \(api\.norr\.finance\): the connection dropped/);
  });

  it("a wrong signature is not retried and says it was the verify step", async () => {
    const { api, calls } = scriptedApi([json(challenge), json({ error: "Invalid signature" }, 401)]);
    const e = await walletSignIn(api, { load: fakeKit().load, retry: noWait }).catch((x: unknown) => x);
    expect((e as Error).message).toBe("Sign-in failed while checking the signature with Norr (api.norr.finance): Invalid signature");
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["an Error", () => Promise.reject(new Error("User rejected"))],
    ["a string", () => Promise.reject("User rejected")],
    ["a plain object", () => Promise.reject({ message: "User rejected" })],
  ])("the wallet refusing (%s) is the signing step, with the wallet's words, and is not retried", async (_n, refuse) => {
    const sign = vi.fn(refuse);
    const f = fakeKit({ signInAndSign: sign });
    const e = await walletSignIn(scriptedApi([json(challenge)]).api, { load: f.load, retry: noWait }).catch((x: unknown) => x);
    expect((e as Error).message).toBe("Sign-in failed while signing the challenge in your wallet: User rejected");
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("a signature of the wrong length is the signing step, named, before Norr is asked to verify it", async () => {
    const f = fakeKit({ signInAndSign: async () => ({ wallet: fakeKit().wallet, signed: signed({ signature: bytesToBase64(new Uint8Array(10)) }) }) });
    const { api, calls } = scriptedApi([json(challenge)]);
    const e = await walletSignIn(api, { load: f.load, retry: noWait }).catch((x: unknown) => x);
    expect((e as Error).message).toBe("Sign-in failed while signing the challenge in your wallet: The wallet returned a signature of 10 bytes; an ed25519 signature is 64.");
    expect(calls.map((c) => c.path)).toEqual(["/owner/v1/challenge"]);
  });

  it("a CSP-blocked origin during sign-in is named in the error", async () => {
    const f = fakeKit({
      signInAndSign: async () => {
        const ev = new Event("securitypolicyviolation") as Event & { blockedURI: string; effectiveDirective: string };
        Object.assign(ev, { blockedURI: "https://relay.example-wallet.app/x", effectiveDirective: "connect-src" });
        document.dispatchEvent(ev);
        throw loadFailed();
      },
    });
    const e = await walletSignIn(scriptedApi([json(challenge)]).api, { load: f.load, retry: noWait }).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/The browser blocked: https:\/\/relay\.example-wallet\.app \(connect-src\)\./);
  });
});

describe("approval signing (the in-dashboard vote)", () => {
  const nonce = new Uint8Array(32).fill(7);
  const msg = "approve:abc:ed25519:WALLET:deadbeef";

  it("signs exactly the message, recipient and nonce it was given, and returns base64 plus who signed", async () => {
    const f = fakeKit({ signMessage: async () => signed({ signature: `ed25519:${base58Encode(SIG)}`, accountId: "norrfi.near", publicKey: "ed25519:V" }) });
    const v = await signVote(msg, "outlayer.near", nonce, "norrfi.near", f.load);
    expect(f.wallet.signMessage).toHaveBeenCalledWith({ message: msg, recipient: "outlayer.near", nonce });
    expect(v).toEqual({ signature: SIG_B64, publicKey: "ed25519:V", accountId: "norrfi.near" });
  });

  it("a dropped connection while the owner is in the wallet is retried: a signature changes nothing on chain", async () => {
    let n = 0;
    const f = fakeKit({ signMessage: async () => (n++ === 0 ? Promise.reject(new Error("The network connection was lost.")) : signed()) });
    await expect(signVote(msg, "outlayer.near", nonce, "owner.near", f.load)).resolves.toMatchObject({ signature: SIG_B64 });
    expect(n).toBe(2);
  });

  it("the owner refusing is passed on in the wallet's words, once", async () => {
    const f = fakeKit({ signMessage: async () => Promise.reject({ message: "User rejected" }) });
    await expect(signVote(msg, "outlayer.near", nonce, "owner.near", f.load)).rejects.toThrow("User rejected");
    expect(f.wallet.signMessage).toHaveBeenCalledTimes(1);
  });

  it("no connected wallet says so, plainly", async () => {
    const f = fakeKit({ connected: async () => Promise.reject(new Error("No wallet selected")) });
    await expect(signVote(msg, "outlayer.near", nonce, "owner.near", f.load)).rejects.toThrow("Your wallet is not connected. Sign in again.");
    expect(f.wallet.signMessage).not.toHaveBeenCalled();
  });
});

describe("unlocking the private reasoning (a fixed message whose signature derives the key)", () => {
  it("signs the fixed unlock message, and derives the same key bytes whichever text the wallet signs in", async () => {
    const a = fakeKit({ signMessage: async () => signed() });
    const b = fakeKit({ signMessage: async () => signed({ signature: `ed25519:${base58Encode(SIG)}` }) });
    const [ka, kb] = [await signUnlock(a.load), await signUnlock(b.load)];
    expect(Array.from(ka)).toEqual(Array.from(SIG));
    expect(Array.from(kb)).toEqual(Array.from(ka));
    expect(a.wallet.signMessage).toHaveBeenCalledWith({ message: UNLOCK_MESSAGE, recipient: UNLOCK_RECIPIENT, nonce: UNLOCK_NONCE });
  });

  it("no connected wallet: asks the owner to sign in again", async () => {
    await expect(signUnlock(fakeKit({ connected: async () => Promise.reject(new Error("x")) }).load)).rejects.toThrow("Your wallet is not connected. Sign in again.");
  });
});

describe("the vault policy transaction (store_wallet_policy)", () => {
  const call: PolicyStoreCall = { contractId: "outlayer.near", methodName: "store_wallet_policy", args: { wallet_pubkey: "ed25519:W", encrypted_data: "AAEC", wallet_signature: "SIG" }, gas: "100000000000000", deposit: "38490000000000000000000" };
  const api = {} as Api;

  it("sends one function call from the owner's account, in NEAR Connect's action format, with the shown deposit", async () => {
    const f = fakeKit();
    await sendPolicyStore(api, call, "owner.near", f.load);
    expect(f.wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
    expect(f.wallet.signAndSendTransaction).toHaveBeenCalledWith({
      signerId: "owner.near",
      receiverId: "outlayer.near",
      actions: [{ type: "FunctionCall", params: { methodName: "store_wallet_policy", args: call.args, gas: "100000000000000", deposit: "38490000000000000000000" } }],
    });
  });

  it("refuses when the wallet is connected as someone else, naming both accounts, and sends nothing", async () => {
    const f = fakeKit({ accounts: [{ accountId: "someone.near" }] });
    await expect(sendPolicyStore(api, call, "owner.near", f.load)).rejects.toThrow("Your wallet is connected as someone.near, but this vault belongs to owner.near. Switch accounts in your wallet and try again.");
    expect(f.wallet.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("works when the owner's account is one of several the wallet holds", async () => {
    const f = fakeKit({ accounts: [{ accountId: "other.near" }, { accountId: "owner.near" }] });
    await sendPolicyStore(api, call, "owner.near", f.load);
    expect(vi.mocked(f.wallet.signAndSendTransaction).mock.calls[0]![0].signerId).toBe("owner.near");
  });

  it("a dropped connection is NOT retried (the transaction may already be on chain) and the message says to check the wallet", async () => {
    const f = fakeKit({ signAndSendTransaction: async () => Promise.reject(new Error("Load failed")) });
    const e = await sendPolicyStore(api, call, "owner.near", f.load).catch((x: unknown) => x);
    expect((e as Error).message).toBe("The connection dropped while HOT Wallet was working (Load failed). The transaction may already have gone through: check HOT Wallet's activity before trying again.");
    expect(f.wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("the owner declining in the wallet is shown in the wallet's words", async () => {
    const f = fakeKit({ signAndSendTransaction: async () => Promise.reject("User rejected the transaction") });
    await expect(sendPolicyStore(api, call, "owner.near", f.load)).rejects.toThrow("User rejected the transaction");
  });

  it("no connected wallet: asks the owner to sign in again", async () => {
    await expect(sendPolicyStore(api, call, "owner.near", fakeKit({ connected: async () => Promise.reject(new Error("x")) }).load)).rejects.toThrow("Your wallet is not connected. Sign in again.");
  });
});

describe("the direct NEAR deposit (ft_transfer_call to intents.near)", () => {
  const d = { contractId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", methodName: "ft_transfer_call" as const, args: { receiver_id: "intents.near", amount: "1000000", msg: "882c084a" }, gas: "100000000000000", deposit: "1", amountUsdc: 1, recipient: "882c084a", note: "" };

  it("sends the call from the connected account and returns who sent it", async () => {
    const f = fakeKit({ accounts: [{ accountId: "payer.near" }] });
    expect(await sendDirectDeposit({} as Api, d, f.load)).toBe("payer.near");
    expect(f.wallet.signAndSendTransaction).toHaveBeenCalledWith({ signerId: "payer.near", receiverId: d.contractId, actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer_call", args: d.args, gas: d.gas, deposit: "1" } }] });
  });

  it("never retries a dropped connection either", async () => {
    const f = fakeKit({ signAndSendTransaction: async () => Promise.reject("Failed to fetch") });
    await expect(sendDirectDeposit({} as Api, d, f.load)).rejects.toThrow(/may already have gone through/);
    expect(f.wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("sign-out", () => {
  it("with no wallet remembered it does not even load the library", async () => {
    const load = vi.fn(async () => fakeKit().kit);
    await disconnectWallet(load);
    expect(load).not.toHaveBeenCalled();
  });

  it("with one remembered it signs the wallet out, so the next sign-in starts from the whole picker", async () => {
    localStorage.setItem("selected-wallet", "hot-wallet");
    const f = fakeKit();
    await disconnectWallet(f.load);
    expect(f.kit.disconnect).toHaveBeenCalledTimes(1);
  });

  it("a library that cannot load never makes sign-out fail", async () => {
    localStorage.setItem("selected-wallet", "hot-wallet");
    await expect(disconnectWallet(async () => Promise.reject(new Error("offline")))).resolves.toBeUndefined();
  });
});
