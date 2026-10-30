import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveOwnerKey, openBox } from "../../web/src/lib/seal";
import { req } from "./fixtures";
import { DataCipher, FileSealKeys, MemorySealKeys, SealingLedger } from "./seal";
import { MemoryLedger } from "./state";

const T0 = Date.UTC(2026, 10, 3, 12);
const sig = (n: number) => Uint8Array.from({ length: 64 }, (_, i) => (i * 5 + n) & 0xff);
const decided = { status: "failed" as const, message: "x" };
const setup = () => {
  const inner = new MemoryLedger();
  const keys = new MemorySealKeys();
  const cipher = DataCipher.random();
  return { inner, keys, cipher, ledger: new SealingLedger(inner, keys, cipher, (id) => (id === "v1" ? "owner.near" : undefined)) };
};

describe("SealingLedger", () => {
  it("never stores the reasoning in the clear, with or without an enrolled key", async () => {
    const { inner, keys, ledger } = setup();
    ledger.append({ vaultId: "v1", at: T0, request: req({ reason: "BEFORE-ENROLL-THESIS" }), decision: decided });
    const owner = await deriveOwnerKey(sig(1), "owner.near");
    keys.set("owner.near", owner.publicKey);
    ledger.append({ vaultId: "v1", at: T0, request: req({ reason: "AFTER-ENROLL-THESIS" }), decision: decided });
    expect(JSON.stringify(inner.list("v1"))).not.toMatch(/THESIS/);
    expect(inner.list("v1").map((r) => r.sealedReason?.k)).toEqual(["service", "owner"]);
    expect(inner.list("v1").every((r) => r.request.reason === "")).toBe(true);
  });

  it("an enrolled key means the service cannot read the reasoning back; the owner can", async () => {
    const { ledger, keys } = setup();
    const owner = await deriveOwnerKey(sig(1), "owner.near");
    keys.set("owner.near", owner.publicKey);
    const row = ledger.append({ vaultId: "v1", at: T0, request: req({ reason: "for the owner only" }), decision: decided });
    expect(row.sealedReason?.k).toBe("owner");
    if (row.sealedReason?.k === "owner") expect(await openBox(row.sealedReason, owner, "v1")).toBe("for the owner only");
  });

  it("reasoning stored before enrollment moves to the owner's key when they enroll, and only the owner can open it", async () => {
    const { ledger, cipher } = setup();
    const row = ledger.append({ vaultId: "v1", at: T0, request: req({ reason: "early thesis" }), decision: decided });
    expect(row.sealedReason?.k).toBe("service");
    if (row.sealedReason?.k === "service") expect(cipher.decrypt(row.sealedReason, "v1")).toBe("early thesis");

    const owner = await deriveOwnerKey(sig(1), "owner.near");
    expect(ledger.reseal("v1", owner.publicKey)).toBe(1);
    const after = ledger.get(row.id)!.sealedReason!;
    expect(after.k).toBe("owner");
    if (after.k === "owner") expect(await openBox(after, owner, "v1")).toBe("early thesis");
    expect(ledger.reseal("v1", owner.publicKey)).toBe(0); // nothing left to move
  });

  it("seals reasoning an older version left in the clear, once", () => {
    const { inner, ledger } = setup();
    inner.append({ vaultId: "v1", at: T0, request: req({ reason: "OLD-PLAINTEXT" }), decision: decided });
    expect(ledger.sealExisting("v1")).toBe(1);
    expect(JSON.stringify(inner.list("v1"))).not.toContain("OLD-PLAINTEXT");
    expect(ledger.sealExisting("v1")).toBe(0);
  });

  it("entries without reasoning get no box, and updates pass through", () => {
    const { ledger } = setup();
    const row = ledger.append({ vaultId: "v1", at: T0, request: req({ reason: "" }), decision: decided });
    expect(row.sealedReason).toBeUndefined();
    ledger.update(row.id, { note: "n" });
    expect(ledger.get(row.id)?.note).toBe("n");
  });

  it("a box cannot be moved to another vault's entry (it is bound to its vault)", async () => {
    const { ledger, keys } = setup();
    const owner = await deriveOwnerKey(sig(1), "owner.near");
    keys.set("owner.near", owner.publicKey);
    const row = ledger.append({ vaultId: "v1", at: T0, request: req({ reason: "r" }), decision: decided });
    await expect(openBox(row.sealedReason as never, owner, "v2")).rejects.toThrow();
  });
});

describe("FileSealKeys", () => {
  it("keeps enrolled public keys across restarts and rejects malformed ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "norr-keys-"));
    const owner = await deriveOwnerKey(sig(1), "owner.near");
    new FileSealKeys(dir).set("owner.near", owner.publicKey);
    expect(new FileSealKeys(dir).get("owner.near")).toBe(owner.publicKey);
    expect(() => new FileSealKeys(dir).set("x.near", "AAAA")).toThrow(/32-byte/);
  });
});
