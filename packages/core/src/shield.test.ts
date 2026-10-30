import { describe, expect, it } from "vitest";
import { NVDA_ON, SOL, registry } from "./fixtures";
import { checkShield, type ShieldFeed } from "./shield";

const r = registry();
const sol = r.byId(SOL.assetId)!;
const nvda = r.byId(NVDA_ON.assetId)!;
const incidents = (...i: ShieldFeed extends infer F ? (F extends { incidents: infer X } ? X : never) : never) =>
  ({ status: "incidents", incidents: i }) as ShieldFeed;

describe("shield incident feed", () => {
  it("passes when operational", () => {
    expect(checkShield({ status: "operational" }, sol)).toBeNull();
  });

  it("blocks on a matching chain incident, with the public description", () => {
    const b = checkShield(incidents({ scopeType: "chain", scopeValue: "SOL", publicDescription: "Bridge paused." }), sol)!;
    expect(b.code).toBe("SHIELD_INCIDENT");
    expect(b.message).toContain("Bridge paused.");
  });

  it("ignores incidents on other chains", () => {
    expect(checkShield(incidents({ scopeType: "chain", scopeValue: "eth" }), sol)).toBeNull();
  });

  it("matches token, bridge and address scopes", () => {
    expect(checkShield(incidents({ scopeType: "token", scopeValue: NVDA_ON.assetId }), nvda)).toMatchObject({ code: "SHIELD_INCIDENT" });
    expect(checkShield(incidents({ scopeType: "bridge", scopeValue: "bsc-nvdaon" }), nvda)).toMatchObject({ code: "SHIELD_INCIDENT" });
    const addr = incidents({ scopeType: "address", scopeValue: "0xABC" });
    expect(checkShield(addr, nvda, { addresses: ["0xabc"] })).toMatchObject({ code: "SHIELD_INCIDENT" });
    expect(checkShield(addr, nvda)).toBeNull();
  });

  it("fails closed when the feed is unreachable, unless told to fail open", () => {
    const b = checkShield(null, sol)!;
    expect(b.code).toBe("SHIELD_INCIDENT");
    expect(b.message).toContain("No trade was made");
    expect(b.message).toContain("retry");
    expect(checkShield(null, sol, { onUnavailable: "allow" })).toBeNull();
  });
});
