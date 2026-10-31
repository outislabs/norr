import { describe, expect, it } from "vitest";
import { DIGEST, buildQuote, compose, eventDigest, fixture, sha } from "./attestation.fixture";
import real from "./attestation.real.fixture.json";
import { allPass, bytesToHex, checkAttestation, composeImages, hexToBytes, parseEventLog, parseQuote, replayRtmr3, verifyQuoteWithPhala, type EventLogEntry } from "./attestation";

const byId = (checks: Awaited<ReturnType<typeof checkAttestation>>) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe("attestation checks", () => {
  it("passes when the quote, event log and configuration agree", async () => {
    const f = fixture();
    const checks = await checkAttestation(f.nonce, f.evidence, f.info);
    expect(byId(checks)).toEqual({ "quote-format": "pass", fresh: "pass", "compose-hash": "pass", "event-log": "pass", "images-pinned": "pass" });
    expect(allPass(checks)).toBe(true);
  });

  it("a shorter nonce is accepted when the rest of the report data is zero", async () => {
    const f = fixture({ nonce: "c0ffee" });
    expect(byId(await checkAttestation("c0ffee", f.evidence, f.info)).fresh).toBe("pass");
  });

  it("rejects a quote made for a different nonce (a replay)", async () => {
    const f = fixture();
    expect(byId(await checkAttestation("22".repeat(32), f.evidence, f.info)).fresh).toBe("fail");
  });

  it("rejects a configuration that does not hash to the measured compose-hash", async () => {
    const f = fixture();
    const swapped = compose(`ghcr.io/outislabs/norr@sha256:${"b".repeat(64)}`);
    const c = byId(await checkAttestation(f.nonce, f.evidence, { appCompose: swapped }));
    expect(c["compose-hash"]).toBe("fail");
    expect(c["images-pinned"]).toBe("pass"); // pinned, but not the measured configuration
  });

  it("rejects an event log that was edited after the hardware measured it", async () => {
    const f = fixture();
    const edited = f.events.map((e) => (e.event === "instance-id" ? { ...e, digest: sha("sha384", "other").toString("hex") } : e));
    const c = byId(await checkAttestation(f.nonce, { ...f.evidence, eventLog: JSON.stringify(edited) }, f.info));
    expect(c["event-log"]).toBe("fail");
  });

  it("rejects an image referenced by a tag instead of a digest", async () => {
    const f = fixture({ appCompose: compose("ghcr.io/outislabs/norr:latest") });
    const c = await checkAttestation(f.nonce, f.evidence, f.info);
    expect(byId(c)["images-pinned"]).toBe("fail");
    expect(c.find((x) => x.id === "images-pinned")!.detail).toContain("ghcr.io/outislabs/norr:latest");
    expect(allPass(c)).toBe(false);
  });

  it("never throws on junk: each unreadable part is a failed check", async () => {
    const f = fixture();
    for (const evidence of [{ ...f.evidence, quote: "zz" }, { ...f.evidence, quote: "00".repeat(10) }, { ...f.evidence, eventLog: "nope" }, { ...f.evidence, eventLog: "{}" }]) {
      const checks = await checkAttestation(f.nonce, evidence, f.info);
      expect(allPass(checks)).toBe(false);
      expect(checks.some((c) => c.status === "fail")).toBe(true);
    }
    expect(allPass(await checkAttestation(f.nonce, f.evidence, { appCompose: "not json" }))).toBe(false);
    expect(allPass(await checkAttestation("not hex", f.evidence, f.info))).toBe(false);
    expect(allPass([])).toBe(false);
  });
});

describe("parsing", () => {
  it("reads RTMR3 and the report data from fixed offsets and refuses non-TDX or other versions", () => {
    const f = fixture();
    const q = parseQuote(f.evidence.quote);
    expect(q.rtmr3).toBe(f.rtmr.toString("hex"));
    expect(q.reportData.startsWith(f.nonce)).toBe(true);
    expect(() => parseQuote(buildQuote({ rtmr3: Buffer.alloc(48), reportData: Buffer.alloc(64), version: 5 }))).toThrow(/version 5/);
    expect(() => parseQuote(buildQuote({ rtmr3: Buffer.alloc(48), reportData: Buffer.alloc(64), teeType: 0 }))).toThrow(/0x81/);
    expect(() => parseQuote("00")).toThrow(/too short/);
  });

  it("replays RTMR3 from zeros and only over IMR 3, recomputing each digest", async () => {
    expect(await replayRtmr3([])).toBe("00".repeat(48));
    const e: EventLogEntry = { imr: 3, event_type: 7, digest: eventDigest(7, "x", "ab"), event: "x", event_payload: "ab" };
    const expected = sha("sha384", Buffer.concat([Buffer.alloc(48), Buffer.from(e.digest, "hex")])).toString("hex");
    expect(await replayRtmr3([e, { imr: 1, digest: "ff".repeat(48), event: "y", event_payload: "" }])).toBe(expected);
    expect(await replayRtmr3([{ ...e, digest: "" }])).toBe(expected); // a log may omit the digest: it is recomputed anyway
  });

  it("refuses an event whose stated digest is not the hash of its content", async () => {
    await expect(replayRtmr3([{ imr: 3, event_type: 7, digest: "00".repeat(48), event: "x", event_payload: "ab" }])).rejects.toThrow(/stated digest/);
  });

  it("passes the checks that do not need our nonce on a real dstack report (NEAR AI Cloud gateway), and fails when it is tampered with", async () => {
    const { quote, eventLog, appCompose } = real as { quote: string; eventLog: string; appCompose: string };
    const nonce = parseQuote(quote).reportData.slice(0, 64);
    const ok = await checkAttestation(nonce, { quote, eventLog }, { appCompose });
    const by = (cs: typeof ok, id: string) => cs.find((c) => c.id === id)?.status;
    expect(by(ok, "quote-format")).toBe("pass");
    expect(by(ok, "compose-hash")).toBe("pass");
    expect(by(ok, "event-log")).toBe("pass");
    const tampered = await checkAttestation(nonce, { quote, eventLog }, { appCompose: appCompose.replace("image:", "image :") });
    expect(by(tampered, "compose-hash")).toBe("fail");
    const log = JSON.parse(eventLog) as EventLogEntry[];
    const i = log.findIndex((x) => x.imr === 3 && x.event_payload);
    log[i] = { ...log[i]!, event_payload: "00" + log[i]!.event_payload.slice(2) };
    expect(by(await checkAttestation(nonce, { quote, eventLog: JSON.stringify(log) }, { appCompose }), "event-log")).toBe("fail");
  });

  it("validates hex and the event log shape", () => {
    expect(bytesToHex(hexToBytes("0xDEADbeef"))).toBe("deadbeef");
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => parseEventLog('[{"imr":3}]')).toThrow(/malformed/);
  });

  it("lists every image in the compose file and whether it is pinned", () => {
    const c = JSON.stringify({ docker_compose_file: `services:\n  a:\n    image: "x/a@sha256:${DIGEST}"\n  b:\n    image: x/b:1\n  c:\n    build: .\n` });
    expect(composeImages(c)).toEqual([{ image: `x/a@sha256:${DIGEST}`, pinned: true }, { image: "x/b:1", pinned: false }]);
    expect(() => composeImages(JSON.stringify({}))).toThrow(/docker_compose_file/);
  });
});

describe("verifyQuoteWithPhala", () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("passes only when the service says the quote verified, and sends the hex without 0x", async () => {
    let sent = "";
    const f: typeof fetch = async (url, init) => ((sent = String(init?.body)), new Response(JSON.stringify({ success: true, quote: { verified: true } })));
    expect((await verifyQuoteWithPhala("0xabcd", f)).status).toBe("pass");
    expect(JSON.parse(sent)).toEqual({ hex: "abcd" });
    expect((await verifyQuoteWithPhala("abcd", reply(200, { success: true, quote: { verified: false } }))).status).toBe("fail");
    expect((await verifyQuoteWithPhala("abcd", reply(200, { success: true }))).status).toBe("fail");
  });

  it("is skipped, not failed or passed, when the service cannot be reached or errors", async () => {
    expect((await verifyQuoteWithPhala("abcd", reply(500, {}))).status).toBe("skipped");
    expect((await verifyQuoteWithPhala("abcd", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).status).toBe("skipped");
  });
});
