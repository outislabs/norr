import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initSync, js_verify } from "@phala/dcap-qvl-web";
import fixture from "./fixtures/tdx-quote.json";
import { PCCS_URL, hexToBytes, signatureCheck, verifyQuoteSignature, type Qvl } from "./qvl";

// The real verifier, with the real collateral served from the fixture instead of the network.
const offline: Qvl = { getCollateral: async () => fixture.collateral, verify: (q, c, now) => js_verify(q, c, now) };
const at = fixture.verifiedAt * 1000;

beforeAll(() => {
  const pkg = dirname(createRequire(import.meta.url).resolve("@phala/dcap-qvl-web"));
  initSync({ module: readFileSync(join(pkg, "dcap-qvl-web_bg.wasm")) });
});

describe("in-browser quote signature check (dcap-qvl)", () => {
  it("passes a real quote from our CVM against Intel's root certificate", async () => {
    const c = await verifyQuoteSignature(fixture.quoteHex, offline, at);
    expect(c).toMatchObject({ id: "quote-signature", status: "pass" });
    expect(c.detail).toContain("up to date");
  });

  it("fails a quote with a single flipped byte", async () => {
    const q = hexToBytes(fixture.quoteHex);
    q[600]! ^= 1;
    const hex = Array.from(q, (b) => b.toString(16).padStart(2, "0")).join("");
    const c = await verifyQuoteSignature(hex, offline, at);
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/does not verify/);
  });

  it("is skipped, not passed, when the certificate data cannot be fetched", async () => {
    const getCollateral = vi.fn(async () => { throw new Error("network"); });
    const c = await verifyQuoteSignature(fixture.quoteHex, { getCollateral, verify: () => ({ status: "UpToDate" }) }, at);
    expect(c.status).toBe("skipped");
    expect(getCollateral).toHaveBeenCalledWith(PCCS_URL, expect.any(Uint8Array));
  });

  it("fails revoked platforms and names the TCB status otherwise", () => {
    expect(signatureCheck({ status: "Revoked" }).status).toBe("fail");
    const c = signatureCheck({ status: "SWHardeningNeeded", advisory_ids: ["INTEL-SA-00615"] });
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("SWHardeningNeeded");
    expect(c.detail).toContain("INTEL-SA-00615");
  });

  it("rejects input that is not hex", async () => {
    expect((await verifyQuoteSignature("zz", offline, at)).status).toBe("fail");
  });
});
