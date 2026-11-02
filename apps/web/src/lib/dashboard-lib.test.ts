import { describe, expect, it } from "vitest";
import { chartGeometry } from "./chart";
import { mcpSnippets } from "./mcp";
import { allDone, onboardingSteps } from "./onboarding";

const pt = (t: number, totalUsd: number) => ({ t, totalUsd, cryptoUsd: totalUsd, equityUsd: 0 });

describe("chartGeometry", () => {
  it("draws nothing for fewer than two readings", () => {
    expect(chartGeometry([], 600, 140).line).toBe("");
    expect(chartGeometry([pt(1, 10)], 600, 140)).toMatchObject({ line: "", first: 10, last: 10 });
  });

  it("scales time to x and value to y inside the padding, oldest first, whatever order it is given", () => {
    const g = chartGeometry([pt(200, 20), pt(0, 10), pt(100, 15)], 600, 140, 6);
    const nums = [...g.line.matchAll(/(\d+\.\d),(\d+\.\d)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(nums).toHaveLength(3);
    expect(nums[0]![0]).toBeCloseTo(6);
    expect(nums[2]![0]).toBeCloseTo(594);
    expect(nums[0]![1]).toBeGreaterThan(nums[2]![1]!); // lower value is lower on screen (larger y)
    expect(nums.every(([x, y]) => x! >= 6 && x! <= 594 && y! >= 6 && y! <= 134)).toBe(true);
    expect(g).toMatchObject({ first: 10, last: 20, min: 10, max: 20 });
    expect(g.area.endsWith("Z")).toBe(true);
  });

  it("keeps a flat vault flat, in the middle of the box, not stretched", () => {
    const g = chartGeometry([pt(0, 50), pt(60, 50), pt(120, 50)], 600, 140, 6);
    const ys = [...g.line.matchAll(/,(\d+\.\d)/g)].map((m) => Number(m[1]));
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBeCloseTo(70, 0);
  });
});

describe("mcpSnippets", () => {
  it("uses a placeholder until a token exists, then the token, and always the given endpoint", () => {
    const before = mcpSnippets("https://x-8788.example/mcp", null);
    expect(before.every((s) => s.text.includes("https://x-8788.example/mcp"))).toBe(true);
    expect(before.every((s) => s.text.includes("PASTE_YOUR_AGENT_TOKEN"))).toBe(true);
    const after = mcpSnippets("https://x-8788.example/mcp", "norr_agent_abc");
    expect(after.every((s) => s.text.includes("norr_agent_abc") && !s.text.includes("PASTE_YOUR"))).toBe(true);
  });

  it("the Claude Desktop snippet is valid JSON and keeps the token out of args", () => {
    const d = mcpSnippets("https://x/mcp", "norr_agent_abc").find((s) => s.client === "claude-desktop")!;
    const parsed = JSON.parse(d.text) as { mcpServers: { norr: { args: string[]; env: Record<string, string> } } };
    expect(parsed.mcpServers.norr.args.join(" ")).not.toContain("norr_agent_abc");
    expect(parsed.mcpServers.norr.env.NORR_AUTH).toBe("Bearer norr_agent_abc");
  });

  it("only the path we ran end to end is labelled tested", () => {
    expect(mcpSnippets("https://x/mcp", null).filter((s) => s.status === "tested").map((s) => s.client)).toEqual(["norr-agent"]);
  });
});

describe("onboardingSteps", () => {
  const base = { totalUsd: 0, tokenIssued: false, hasActivity: false, rulesReviewed: false };
  it("starts with only the vault done and funding next", () => {
    const s = onboardingSteps(base);
    expect(s.map((x) => [x.id, x.done])).toEqual([["vault", true], ["fund", false], ["rules", false], ["connect", false]]);
    expect(allDone(s)).toBe(false);
  });

  it("funding is done once the vault holds value; connecting once a token exists or the agent has acted", () => {
    expect(onboardingSteps({ ...base, totalUsd: 5 })[1]!.done).toBe(true);
    expect(onboardingSteps({ ...base, totalUsd: null })[1]!.done).toBe(false);
    expect(onboardingSteps({ ...base, tokenIssued: true })[3]!.done).toBe(true);
    expect(onboardingSteps({ ...base, hasActivity: true })[3]!.done).toBe(true);
    expect(allDone(onboardingSteps({ totalUsd: 5, tokenIssued: true, hasActivity: false, rulesReviewed: true }))).toBe(true);
  });
});
