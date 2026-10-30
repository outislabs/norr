import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { base58Decode, nep413Hash as serverHash, verifyNep413 } from "../../../enclave/src/owner/nep413";
import { ApiError, createApi } from "./api";
import { ago, amount, shortId, usd } from "./format";
import { base58Encode, base64ToBytes, generateDemoKey, nep413Hash } from "./nep413";
import { parseRoute, vaultHref } from "./route";

describe("browser NEP-413 matches the server", () => {
  const nonce = new Uint8Array(32).map((_, i) => i);

  it("hashes exactly the bytes the server hashes, with and without a callback URL", async () => {
    for (const callbackUrl of [undefined, "https://app.example/cb"]) {
      const m = { message: "Sign in to Norr\nIssued: now", nonce, recipient: "norr", callbackUrl };
      const browser = Buffer.from(await nep413Hash(m));
      const server = serverHash({ ...m, nonce: Buffer.from(nonce) });
      expect(browser.equals(server)).toBe(true);
    }
  });

  it("a signature made in the browser verifies on the server, and not after any change", async () => {
    const key = await generateDemoKey();
    const m = { message: "hello", nonce, recipient: "norr" };
    const sig = await key.sign(m);
    const serverMsg = { message: m.message, nonce: Buffer.from(nonce), recipient: m.recipient };
    expect(verifyNep413(serverMsg, key.publicKey, sig)).toBe(true);
    expect(verifyNep413({ ...serverMsg, message: "hello!" }, key.publicKey, sig)).toBe(false);
    expect(verifyNep413({ ...serverMsg, recipient: "evil" }, key.publicKey, sig)).toBe(false);
  });

  it("base58 round-trips with the server's decoder, including leading zero bytes", () => {
    for (const bytes of [new Uint8Array([0, 0, 1, 2, 3]), new Uint8Array(32).fill(255), generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32)]) {
      expect(base58Decode(base58Encode(new Uint8Array(bytes))).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it("decodes base64 nonces and rejects a short nonce", async () => {
    expect(base64ToBytes(Buffer.alloc(32, 7).toString("base64"))).toHaveLength(32);
    await expect(nep413Hash({ message: "m", nonce: new Uint8Array(31), recipient: "r" })).rejects.toThrow();
  });
});

describe("api client", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("sends the bearer token only when there is one, and prefixes the base path", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init!.headers as Record<string, string> });
      return json({ vaults: [] });
    });
    let token: string | null = null;
    const api = createApi({ base: "/api", getToken: () => token, onUnauthorized: () => undefined, fetch: f as unknown as typeof fetch });
    await api.vaults();
    token = "norr_owner_abc";
    await api.vaults();
    expect(calls[0]!.url).toBe("/api/owner/v1/vaults");
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[1]!.headers.authorization).toBe("Bearer norr_owner_abc");
  });

  it("signs the user out on 401 when a session existed, and reports plain errors", async () => {
    const out = vi.fn();
    const api = createApi({ base: "", getToken: () => "t", onUnauthorized: out, fetch: (async () => json({ error: "unauthorized" }, 401)) as unknown as typeof fetch });
    await expect(api.me()).rejects.toMatchObject({ status: 401, message: "unauthorized" });
    expect(out).toHaveBeenCalledTimes(1);
    const noSession = vi.fn();
    const login = createApi({ base: "", getToken: () => null, onUnauthorized: noSession, fetch: (async () => json({ error: "sign-in failed" }, 401)) as unknown as typeof fetch });
    await expect(login.login({ accountId: "a", publicKey: "k", signature: "s", nonce: "n" })).rejects.toBeInstanceOf(ApiError);
    expect(noSession).not.toHaveBeenCalled(); // a failed login is not a lost session
  });

  it("explains validation problems and an unreachable service", async () => {
    const bad = createApi({ base: "", getToken: () => "t", onUnauthorized: () => undefined, fetch: (async () => json({ error: "invalid policy", issues: ["maxTradeUsd: too small"] }, 400)) as unknown as typeof fetch });
    await expect(bad.pause("v")).rejects.toThrow("invalid policy: maxTradeUsd: too small");
    const down = createApi({ base: "", getToken: () => null, onUnauthorized: () => undefined, fetch: (async () => { throw new Error("x"); }) as unknown as typeof fetch });
    await expect(down.health()).rejects.toThrow("Cannot reach the Norr service");
  });

  it("encodes vault ids in paths", async () => {
    const urls: string[] = [];
    const api = createApi({ base: "", getToken: () => "t", onUnauthorized: () => undefined, fetch: (async (u: string) => { urls.push(u); return json({}); }) as unknown as typeof fetch });
    await api.vault("a/b c");
    expect(urls[0]).toBe("/owner/v1/vaults/a%2Fb%20c");
  });
});

describe("formatting and routes", () => {
  it("formats money, times and ids", () => {
    expect(usd(1234.5)).toBe("$1,234.50");
    expect(usd(50, 0)).toBe("$50");
    expect(amount(0.015738716)).toBe("0.015739");
    expect(amount(null)).toBe("?");
    expect(shortId("882c084a64e1648a150867ef4b62c82a555b34cfb8a075caeeec3e51eb56aca0")).toBe("882c084a…aca0");
    expect(shortId("short.near")).toBe("short.near");
    const now = Date.parse("2026-11-03T12:00:00Z");
    expect(ago("2026-11-03T11:59:50Z", now)).toBe("just now");
    expect(ago("2026-11-03T11:30:00Z", now)).toBe("30 minutes ago");
    expect(ago("2026-11-03T08:00:00Z", now)).toBe("4 hours ago");
    expect(ago("2026-10-30T08:00:00Z", now)).toBe("2026-10-30");
  });

  it("parses hash routes and falls back safely", () => {
    expect(parseRoute("/")).toEqual({ name: "vaults" });
    expect(parseRoute("#/verify")).toEqual({ name: "verify" });
    expect(parseRoute("/vault/demo/rules")).toEqual({ name: "vault", id: "demo", tab: "rules" });
    expect(parseRoute("/vault/demo")).toEqual({ name: "vault", id: "demo", tab: "overview" });
    expect(parseRoute("/vault/demo/nonsense")).toEqual({ name: "vault", id: "demo", tab: "overview" });
    expect(parseRoute("/vault/a%2Fb/activity")).toEqual({ name: "vault", id: "a/b", tab: "activity" });
    expect(parseRoute("/whatever/else")).toEqual({ name: "vaults" });
    expect(vaultHref("a/b", "rules")).toBe("#/vault/a%2Fb/rules");
  });
});
