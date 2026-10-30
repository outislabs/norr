import { describe, expect, it } from "vitest";
import { harness } from "./fixtures";
import { runLiveTrade, type RunArgs } from "./live-runner";

const args = (over: Partial<RunArgs> = {}): RunArgs => ({
  vaultId: "v1", side: "buy", asset: "NVDA", amountUsd: 30, reason: "test", confirmMainnet: false, maxUsd: 35, waitMinutes: 5, ...over,
});
const run = async (h: ReturnType<typeof harness>, a: RunArgs) => {
  const lines: string[] = [];
  const res = await runLiveTrade(h.deps, a, (l) => lines.push(l));
  return { res, out: lines.join("\n") };
};

describe("runLiveTrade", () => {
  it("is a dry run by default: it shows the plan and the exact request, and sends nothing", async () => {
    const h = harness();
    const { res, out } = await run(h, args());
    expect(res.exitCode).toBe(0);
    expect(h.rails.swaps).toHaveLength(0);
    expect(out).toContain("DRY RUN");
    expect(out).toContain("min_amount_out");
    expect(out).toMatch(/minimum\s+0\.\d+ NVDAon/);
    expect(h.ledger.list("v1")).toHaveLength(0);
  });

  it("executes exactly one swap with --confirm-mainnet", async () => {
    const h = harness();
    const { res, out } = await run(h, args({ confirmMainnet: true }));
    expect(res.exitCode).toBe(0);
    expect(res.decision?.status).toBe("executed");
    expect(h.rails.swaps).toHaveLength(1);
    expect(out).toContain("EXECUTING");
  });

  it("refuses an amount above the per-run cap, even if the vault policy would allow it", async () => {
    const h = harness({ policy: { maxTradeUsd: 500 } });
    const { res, out } = await run(h, args({ amountUsd: 100, confirmMainnet: true }));
    expect(res.exitCode).toBe(1);
    expect(out).toContain("per-run cap");
    expect(h.rails.swaps).toHaveLength(0);
    expect((await run(h, args({ amountUsd: 0 }))).res.exitCode).toBe(1);
    expect((await run(h, args({ amountUsd: -5 }))).res.exitCode).toBe(1);
  });

  it("reports a blocked trade and never sends it, even with --confirm-mainnet", async () => {
    const h = harness({ policy: { nonUsConfirmed: false } });
    const { res, out } = await run(h, args({ confirmMainnet: true }));
    expect(res.exitCode).toBe(2);
    expect(res.decision).toMatchObject({ status: "blocked", code: "INELIGIBLE" });
    expect(out).toContain("WOULD NOT RUN");
    expect(h.rails.swaps).toHaveLength(0);
  });

  it("an unknown vault is an error", async () => {
    const h = harness();
    expect((await run(h, args({ vaultId: "nope" }))).res.exitCode).toBe(1);
  });

  it("waits for the owner's approval, settles it, and still sends only one swap", async () => {
    const h = harness({ mock: { requireApproval: true } });
    let sleeps = 0;
    h.deps.sleep = async (ms) => {
      h.clock.t += ms;
      if (++sleeps === 2) h.rails.approve("mock-req-1"); // the owner approves after a short wait
    };
    const { res, out } = await run(h, args({ confirmMainnet: true }));
    expect(res.exitCode).toBe(0);
    expect(res.decision?.status).toBe("executed");
    expect(out).toContain("https://app.outlayer.ai/wallet/approvals");
    expect(h.rails.swaps).toHaveLength(1);
  });

  it("gives up waiting and leaves the swap pending (exit 3) without resending", async () => {
    const h = harness({ mock: { requireApproval: true } });
    h.deps.sleep = async (ms) => { h.clock.t += ms; };
    const { res } = await run(h, args({ confirmMainnet: true, waitMinutes: 1 }));
    expect(res.exitCode).toBe(3);
    expect(res.decision?.status).toBe("pending_approval");
    expect(h.rails.swaps).toHaveLength(1);
  });

  it("a tampered swap pauses the vault and exits non-zero", async () => {
    const h = harness({ mock: { tamper: (e) => ({ ...e, tokenOut: "nep141:evil.near" }) } });
    const { res } = await run(h, args({ confirmMainnet: true }));
    expect(res.exitCode).toBe(2);
    expect(h.vaults.get("v1")!.policy.paused).toBe(true);
  });
});
