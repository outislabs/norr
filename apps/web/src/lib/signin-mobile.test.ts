// @vitest-environment jsdom
/**
 * The mobile Safari sign-in flow (seen live 2026-11-11 on iPhone: "Failed to sign in with HOT Wallet: Load failed",
 * fixed by retrying by hand). On a phone the owner leaves the page for the HOT app and comes back; Safari suspends the
 * page meanwhile, and a request in flight, or the first one sent on a stale connection, fails with
 * `TypeError: Load failed`. These tests play that sequence: page hidden, request dropped, page visible again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApi, type Api } from "./api";
import { isNetworkError, SignInError, whenVisible, withRetry } from "./resilience";
import { walletSignIn, type SelectorKit } from "./signin";
import { resilientHot } from "./wallets";

const loadFailed = () => new TypeError("Load failed"); // Safari's text for a dropped fetch
const noWait = { sleep: async () => {} };

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => vi.restoreAllMocks());

/** iOS switches to the HOT app, then back. */
const leaveForHot = () => {
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
};
const comeBack = () => {
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A connected-wallet kit: the picker is skipped (an account is already there after connect). */
function kit(signMessage: () => Promise<unknown>) {
  let accounts: { accountId: string }[] = [];
  const subs: ((s: { accounts: unknown[] }) => void)[] = [];
  return {
    selector: {
      store: { getState: () => ({ accounts }), observable: { subscribe: (f: (s: { accounts: unknown[] }) => void) => (subs.push(f), { unsubscribe() {} }) } },
      wallet: async () => ({ metadata: { name: "HOT Wallet" }, signOut: async () => {}, signMessage }),
    },
    setupModal: () => ({ show: () => setTimeout(() => { accounts = [{ accountId: "owner.near" }]; subs.forEach((f) => f({ accounts })); }, 1), on: () => undefined }),
    missing: [],
  } as unknown as SelectorKit;
}
const signed = { accountId: "owner.near", publicKey: "ed25519:K", signature: "sig" };
const challenge = { nonce: Buffer.alloc(32).toString("base64"), message: "m", recipient: "app.norr.finance", expiresAt: 0 };

/** The real API client over a scripted fetch: each entry answers one request in order. */
function scriptedApi(script: (() => Response | Promise<Response>)[]) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(new URL(url).pathname);
    const next = script.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return next();
  });
  return { api: createApi({ base: "https://api.norr.finance", getToken: () => null, onUnauthorized: () => {}, fetch }) as Api, calls };
}
const json = (b: unknown, status = 200) => () => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const drop = () => () => { throw loadFailed(); };

describe("which failures are retried", () => {
  it("a dropped request (Safari, Chrome, Firefox wording, or Norr's offline error) is; an answer saying no is not", () => {
    for (const m of ["Load failed", "Failed to fetch", "NetworkError when attempting to fetch resource.", "The network connection was lost."]) expect(isNetworkError(new TypeError(m))).toBe(true);
    expect(isNetworkError(new ApiError(0, "Norr is offline right now."))).toBe(true);
    expect(isNetworkError(new ApiError(401, "Invalid signature"))).toBe(false);
    expect(isNetworkError(new Error("User rejected"))).toBe(false);
    expect(isNetworkError(new TypeError("Cannot read properties of undefined"))).toBe(false);
  });

  it("withRetry waits for the page to be visible before each attempt", async () => {
    leaveForHot();
    const fn = vi.fn(async () => "ok");
    const p = withRetry(fn, noWait);
    await tick();
    expect(fn).not.toHaveBeenCalled(); // suspended: nothing sent
    comeBack();
    expect(await p).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("whenVisible resolves at once when the page is visible", async () => {
    await expect(whenVisible()).resolves.toBeUndefined();
  });
});

describe("HOT connect: its relay POST dropped (the live failure)", () => {
  /** A HOT module whose signIn fails like the relay POST did, `failures` times. */
  function hot(failures: number, error: () => Error = loadFailed) {
    const signIn = vi.fn(async () => {
      if (signIn.mock.calls.length <= failures) throw error();
      return [{ accountId: "owner.near", publicKey: "ed25519:K" }];
    });
    const signMessage = vi.fn(async () => signed);
    const factory = resilientHot(async () => ({ id: "hot-wallet", type: "injected", metadata: {}, init: async () => ({ signIn, signMessage }) }) as never, noWait);
    return { signIn, signMessage, wallet: async () => (await (await factory({} as never))!.init({} as never)) as unknown as { signIn: (a: unknown) => Promise<unknown>; signMessage: (a: unknown) => Promise<unknown> } };
  }

  it("retries a dropped connect and succeeds, with no second prompt (the POST precedes the widget)", async () => {
    const h = hot(1);
    expect(await (await h.wallet()).signIn({})).toEqual([{ accountId: "owner.near", publicKey: "ed25519:K" }]);
    expect(h.signIn).toHaveBeenCalledTimes(2);
  });

  it("when it keeps failing, says it was HOT's relay, not Norr, and what the browser said", async () => {
    const h = hot(10);
    const e = await (await h.wallet()).signIn({}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SignInError);
    expect((e as SignInError).step).toBe("connect");
    expect((e as Error).message).toMatch(/connecting to HOT Wallet \(its relay, h4n\.app\)/);
    expect((e as Error).message).toMatch(/Load failed/);
    expect((e as Error).message).toMatch(/retrying did not help/);
    expect(h.signIn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a refusal (the owner closed HOT): that would prompt again", async () => {
    const h = hot(10, () => new Error("User rejected"));
    await expect((await h.wallet()).signIn({})).rejects.toThrow("User rejected");
    expect(h.signIn).toHaveBeenCalledTimes(1);
  });

  it("the signing request is retried the same way", async () => {
    const h = hot(0);
    h.signMessage.mockRejectedValueOnce(loadFailed());
    expect(await (await h.wallet()).signMessage({})).toEqual(signed);
    expect(h.signMessage).toHaveBeenCalledTimes(2);
  });
});

describe("HOT's real SDK: a dropped relay POST is retried and the sign-in completes", () => {
  it("drives @hot-wallet/sdk against a fake h4n.app whose first POST is dropped", async () => {
    const posts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      expect(new URL(url).origin).toBe("https://h4n.app"); // HOT's only network origin here, and it is in the CSP
      if (init?.method === "POST") {
        posts.push(url);
        if (posts.length === 1) throw loadFailed();
        return new Response("{}", { status: 200 });
      }
      // The reply poll: HOT answered in its app.
      return new Response(JSON.stringify({ data: JSON.stringify({ success: true, payload: { accountId: "owner.near", publicKey: "ed25519:K" } }) }), { status: 200 });
    });
    const { setupHotWallet } = await import("@near-wallet-selector/hot-wallet");
    const module = await resilientHot(setupHotWallet(), noWait)({ options: { network: { networkId: "mainnet" } } } as never);
    const storage = new Map<string, string>();
    const wallet = (await module!.init({ emitter: { emit: () => {} }, storage: { getItem: async (k: string) => storage.get(k) ?? null, setItem: async (k: string, v: string) => void storage.set(k, v) } } as never)) as unknown as { signIn: (a: unknown) => Promise<{ accountId: string }[]> };
    const accounts = await wallet.signIn({ contractId: "" });
    expect(accounts[0]?.accountId).toBe("owner.near");
    expect(posts).toHaveLength(2); // dropped once, sent again
  }, 15_000);
});

describe("Norr's steps on a phone", () => {
  it("challenge dropped once: retried, and sign-in completes", async () => {
    const { api, calls } = scriptedApi([drop(), json(challenge), json({ token: "t", accountId: "owner.near", expiresAt: 1 })]);
    const s = await walletSignIn(api, { load: async () => kit(async () => signed), retry: noWait });
    expect(s.accountId).toBe("owner.near");
    expect(calls).toEqual(["/owner/v1/challenge", "/owner/v1/challenge", "/owner/v1/login"]);
  });

  it("the app switch: verify waits until the owner is back on the page, survives a dropped first try, and completes", async () => {
    const { api, calls } = scriptedApi([json(challenge), drop(), json({ token: "t", accountId: "owner.near", expiresAt: 1 })]);
    // The owner approves in the HOT app; the reply arrives while Safari still shows the HOT app.
    const p = walletSignIn(api, { load: async () => kit(async () => { leaveForHot(); return signed; }), retry: noWait });
    for (let i = 0; i < 20; i++) await tick();
    expect(calls).toEqual(["/owner/v1/challenge"]); // verify not sent while suspended
    comeBack();
    expect((await p).accountId).toBe("owner.near");
    expect(calls).toEqual(["/owner/v1/challenge", "/owner/v1/login", "/owner/v1/login"]);
  });

  it("verify dropped after it reached Norr: the retry is refused (single-use challenge) and the message says to sign in again", async () => {
    const { api } = scriptedApi([json(challenge), drop(), json({ error: "Invalid or expired challenge" }, 401)]);
    const e = await walletSignIn(api, { load: async () => kit(async () => signed), retry: noWait }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SignInError);
    expect((e as SignInError).step).toBe("verify");
    expect((e as Error).message).toMatch(/checking the signature with Norr/);
    expect((e as Error).message).toMatch(/Sign in again/);
  });

  it("Norr unreachable throughout: names the challenge step", async () => {
    const { api } = scriptedApi([drop(), drop(), drop()]);
    const e = await walletSignIn(api, { load: async () => kit(async () => signed), retry: noWait }).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/^Sign-in failed while getting a sign-in challenge from Norr \(api\.norr\.finance\): the connection dropped/);
  });

  it("a wrong signature is not retried and says it was the verify step", async () => {
    const { api, calls } = scriptedApi([json(challenge), json({ error: "Invalid signature" }, 401)]);
    const e = await walletSignIn(api, { load: async () => kit(async () => signed), retry: noWait }).catch((x: unknown) => x);
    expect((e as Error).message).toBe("Sign-in failed while checking the signature with Norr (api.norr.finance): Invalid signature");
    expect(calls).toHaveLength(2);
  });

  it("the wallet refusing to sign is named as the signing step and not retried", async () => {
    const { api } = scriptedApi([json(challenge)]);
    const sign = vi.fn(async () => { throw new Error("User rejected"); });
    const e = await walletSignIn(api, { load: async () => kit(sign), retry: noWait }).catch((x: unknown) => x);
    expect((e as Error).message).toBe("Sign-in failed while signing the challenge in your wallet: User rejected");
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("a CSP-blocked origin during sign-in is named in the error (there is no report endpoint)", async () => {
    const { api } = scriptedApi([json(challenge)]);
    const sign = async () => {
      const ev = new Event("securitypolicyviolation") as Event & { blockedURI: string; effectiveDirective: string };
      Object.assign(ev, { blockedURI: "https://relay.example-hot.app/x", effectiveDirective: "connect-src" });
      document.dispatchEvent(ev);
      throw loadFailed();
    };
    const e = await walletSignIn(api, { load: async () => kit(sign), retry: noWait }).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/The browser blocked: https:\/\/relay\.example-hot\.app \(connect-src\)\./);
  });
});
