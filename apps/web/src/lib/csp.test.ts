import { describe, expect, it } from "vitest";
import { APP_SCHEMES, STATIC_HEADERS, THIRD_PARTY, WALLET_ORIGINS, apiOrigin, buildCsp, headersFile, newNonce, responseHeaders } from "./csp";

const API = "https://85e1d6a557dae81985c9e30e28270f91bee5c0e9-8787.dstack-pha-prod5.phala.network";
const NONCE = "bf9z+U3q0igEb5X2YXgS9Q==";
const directive = (csp: string, name: string): string[] => csp.split("; ").find((d) => d.startsWith(`${name} `))!.split(" ").slice(1);

describe("dashboard CSP", () => {
  it("allows exactly the configured service origin, not its path", () => {
    expect(apiOrigin(`${API}/some/path`)).toBe(API);
    expect(directive(buildCsp(API, NONCE), "connect-src")).toContain(API);
    expect(directive(buildCsp(undefined, NONCE), "connect-src").some((o) => o.includes("phala.network") && o !== "https://pccs.phala.network")).toBe(false);
  });

  it("scripts are strict: this response's nonce, no inline, no eval, no third-party script origin", () => {
    const scripts = directive(buildCsp(API, NONCE), "script-src");
    expect(scripts).toEqual(["'self'", `'nonce-${NONCE}'`, "'wasm-unsafe-eval'"]);
    const csp = buildCsp(API, NONCE);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(directive(csp, "script-src")).not.toContain("'unsafe-inline'");
    expect(csp).not.toMatch(/script-src[^;]*https?:/);
    expect(csp).not.toContain("strict-dynamic");
  });

  it("without a nonce the wallet frames cannot run, and the policy says so by having none", () => {
    expect(directive(buildCsp(API), "script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  });

  it("the one real relaxation is inline styles (NEAR Connect's picker and wallet frames inject <style> without a nonce); nothing else is", () => {
    const csp = buildCsp(API, NONCE);
    expect(directive(csp, "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(csp, "default-src")).toEqual(["'self'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "base-uri")).toEqual(["'none'"]);
    expect(directive(csp, "form-action")).toEqual(["'none'"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]); // this page cannot be framed
    expect(directive(csp, "font-src")).toEqual(["'self'", "data:"]); // no font host
  });

  it("a nonce that is not base64 is refused, so a header cannot be injected through it", () => {
    for (const bad of ["a'; script-src *", "x y", 'q"', "a;b", ""]) expect(() => buildCsp(API, bad)).toThrow(/base64/);
  });

  it("allows only what the observed wallets need, each with its reason, and no font or script host", () => {
    const csp = buildCsp(API, NONCE);
    const connect = directive(csp, "connect-src");
    for (const o of ["https://h4n.app", "https://api0.herewallet.app", "https://mc.meteorwallet.app", "wss://mc.meteorwallet.app", "https://near-mobile-production.aws.peersyst.tech", "https://pccs.phala.network", "https://api.outlayer.ai"]) expect(connect).toContain(o);
    for (const o of ["https://fonts.cdnfonts.com", "https://rsms.me", "https://fonts.googleapis.com", "https://raw.githubusercontent.com", "https://cdn.jsdelivr.net"]) {
      expect(csp, `${o} must stay blocked`).not.toContain(o);
    }
    expect(directive(csp, "frame-src")).toContain("https://wallet.intear.tech");
    // Every wallet entry names a real origin (https or wss), never a wildcard.
    for (const [id, w] of Object.entries(WALLET_ORIGINS)) for (const o of [...w.connect, ...(w.frame ?? []), ...(w.img ?? [])]) expect(o, id).toMatch(/^(https|wss):\/\/[a-z0-9.-]+$/);
    expect(THIRD_PARTY.connect.every((o) => !o.includes("*"))).toBe(true);
  });

  it("native-app deep links are allowed as frames (HOT, Meteor, Intear and NEAR Mobile open them that way), and only those schemes", () => {
    expect(APP_SCHEMES).toEqual(["hotwallet:", "intent:", "meteorwallet:", "intear:", "near-mobile-wallet:"]);
    const frames = directive(buildCsp(API, NONCE), "frame-src");
    for (const s of APP_SCHEMES) expect(frames).toContain(s);
    expect(frames).not.toContain("javascript:");
    expect(frames).not.toContain("data:");
  });

  it("the Pages _headers file has the static headers and no CSP: a second, nonce-less policy would block the wallet frames", () => {
    const h = headersFile();
    for (const [k, v] of Object.entries(STATIC_HEADERS)) expect(h).toContain(`${k}: ${v}`);
    expect(h).not.toMatch(/content-security-policy/i);
    expect(h.startsWith("/*\n")).toBe(true);
  });

  it("every response header set has the CSP and the static headers", () => {
    const h = responseHeaders(API, NONCE);
    expect(h["Content-Security-Policy"]).toBe(buildCsp(API, NONCE));
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
  });

  it("nonces are 128 bits of base64 and differ", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(atob(a)).toHaveLength(16);
    expect(a).not.toBe(b);
    expect(newNonce(() => new Uint8Array(16).fill(7))).toBe(btoa(String.fromCharCode(...new Uint8Array(16).fill(7))));
  });
});
