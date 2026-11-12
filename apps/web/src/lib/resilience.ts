import { ApiError } from "./api";

/**
 * Sign-in on a phone crosses an app switch: the owner taps HOT Wallet, iOS opens the HOT app, and Safari suspends this
 * page. A request in flight at that moment, or the first one sent on a pooled connection that died while suspended, fails
 * with a bare `TypeError: Load failed` (Chrome: "Failed to fetch"). Seen live on app.norr.finance (2026-11-11, iPhone
 * Safari): "Failed to sign in with HOT Wallet: Load failed", gone on a manual retry.
 *
 * These helpers retry such failures, after the page is visible again, and only where a retry cannot double anything.
 */

const NETWORK_TEXT = /load failed|failed to fetch|networkerror|network connection was lost|network request failed|cancelled|internet connection appears to be offline/i;

/** A request that never got an HTTP answer (dropped, killed while suspended), as opposed to an answer saying no. */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 0;
  if (!(e instanceof TypeError)) return false;
  return NETWORK_TEXT.test(e.message);
}

/**
 * The same, for a failure that crossed a wallet's sandbox. NEAR Connect runs each wallet in an iframe and hands its errors
 * back through postMessage, where a dropped fetch can arrive as a plain Error, an object with a message, or a string
 * instead of a TypeError. Only the browser's own network phrases count, so a wallet refusing ("User rejected") never does.
 */
export function isWalletNetworkError(e: unknown): boolean {
  if (isNetworkError(e)) return true;
  if (e instanceof ApiError) return false;
  const text = typeof e === "string" ? e : e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "";
  return NETWORK_TEXT.test(text);
}

/** The text of whatever a wallet rejected with. */
export function failureText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "the wallet did not say why";
}

/** Resolves when the page is visible (at once if it already is): iOS does not run a suspended page's requests. */
export function whenVisible(doc: Document | undefined = typeof document === "undefined" ? undefined : document): Promise<void> {
  if (!doc || doc.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (doc.visibilityState === "hidden") return;
      doc.removeEventListener("visibilitychange", done);
      doc.defaultView?.removeEventListener("pageshow", done);
      resolve();
    };
    doc.addEventListener("visibilitychange", done);
    doc.defaultView?.addEventListener("pageshow", done);
  });
}

export interface RetryOptions {
  /** Total attempts, the first included. */
  attempts?: number;
  /** Wait before each retry (the last value repeats). Short: the owner is looking at a spinner. */
  delaysMs?: number[];
  retryable?: (e: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  visible?: () => Promise<void>;
}

/** Run `fn`, waiting for the page to be visible before each attempt, and retry network failures only. */
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const attempts = o.attempts ?? 3;
  const delays = o.delaysMs ?? [400, 1200];
  const retryable = o.retryable ?? isNetworkError;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const visible = o.visible ?? (() => whenVisible());
  for (let i = 1; ; i++) {
    await visible();
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !retryable(e)) throw e;
      await sleep(delays[Math.min(i - 1, delays.length - 1)] ?? 0);
    }
  }
}

/** The sign-in steps, named the way the error message names them. */
export const SIGN_IN_STEPS = {
  connect: "connecting to your wallet",
  challenge: "getting a sign-in challenge from Norr (api.norr.finance)",
  sign: "signing the challenge in your wallet",
  verify: "checking the signature with Norr (api.norr.finance)",
} as const;
export type SignInStep = keyof typeof SIGN_IN_STEPS;

/** A sign-in failure that says which step failed and why, in plain words. */
export class SignInError extends Error {
  constructor(
    readonly step: SignInStep,
    detail: string,
    readonly cause?: unknown,
  ) {
    super(`Sign-in failed while ${SIGN_IN_STEPS[step]}: ${detail}`);
    this.name = "SignInError";
  }
}

/** The plain-language reason for a failed step. */
export function describeFailure(e: unknown, retried: boolean): string {
  if (isWalletNetworkError(e)) {
    const raw = e instanceof ApiError ? "no answer" : failureText(e);
    return `the connection dropped (${raw})${retried ? " and retrying did not help" : ""}. Check your connection and try again.`;
  }
  return e instanceof Error ? e.message : failureText(e);
}

/**
 * Collects Content-Security-Policy violations while sign-in runs, so a blocked wallet origin is named in the error
 * instead of surfacing as a bare "Load failed". The dashboard has no CSP report endpoint; this is the record.
 */
export function watchCspViolations(doc: Document | undefined = typeof document === "undefined" ? undefined : document) {
  const blocked = new Set<string>();
  const on = (ev: Event) => {
    const v = ev as SecurityPolicyViolationEvent;
    let origin = v.blockedURI || "inline";
    try {
      origin = new URL(v.blockedURI).origin;
    } catch {
      /* "inline", "eval" and the like are not URLs */
    }
    blocked.add(`${origin} (${v.effectiveDirective || v.violatedDirective})`);
  };
  doc?.addEventListener("securitypolicyviolation", on);
  return {
    blocked: () => [...blocked],
    stop: () => doc?.removeEventListener("securitypolicyviolation", on),
  };
}
