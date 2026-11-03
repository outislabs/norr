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
  const all = (s: { blocks: { text: string }[] }) => s.blocks.map((b) => b.text).join("\n");

  it("offers any MCP client first, then the named clients and the REST API", () => {
    expect(mcpSnippets("https://x/mcp", null).map((s) => s.client)).toEqual(["any", "claude-code", "claude-desktop", "cursor", "openai", "rest", "norr-agent"]);
  });

  it("uses a placeholder until a token exists, then the token; MCP snippets use the endpoint, REST the service URL", () => {
    const before = mcpSnippets("https://x-8788.example/mcp", null, "https://x-8787.example");
    expect(before.every((s) => all(s).includes("PASTE_YOUR_AGENT_TOKEN"))).toBe(true);
    for (const s of before) expect(all(s)).toContain(s.client === "rest" ? "https://x-8787.example/v1/trade" : "https://x-8788.example/mcp");
    const after = mcpSnippets("https://x-8788.example/mcp", "norr_agent_abc");
    expect(after.every((s) => all(s).includes("norr_agent_abc") && !all(s).includes("PASTE_YOUR"))).toBe(true);
  });

  it("with the bridge switched off, the stdio blocks fall back to mcp-remote, with the token in env, not args", () => {
    const desk = mcpSnippets("https://x/mcp", "norr_agent_abc", undefined, false).find((s) => s.client === "claude-desktop")!;
    const parsed = JSON.parse(desk.blocks[0]!.text) as { mcpServers: { norr: { args: string[]; env: Record<string, string> } } };
    expect(parsed.mcpServers.norr.args).toEqual(["-y", "mcp-remote", "https://x/mcp", "--header", "Authorization:${NORR_AUTH}"]);
    expect(parsed.mcpServers.norr.env).toEqual({ NORR_AUTH: "Bearer norr_agent_abc" });
    expect(mcpSnippets("https://x/mcp", "t", undefined, false).flatMap((s) => s.blocks).some((b) => b.text.includes("@norrfi/mcp"))).toBe(false);
  });

  it("JSON configs are valid; the stdio bridge gets the token through env, never args, and the endpoint only when it is not the default", () => {
    const desk = mcpSnippets("https://x/mcp", "norr_agent_abc", undefined, true).find((s) => s.client === "claude-desktop")!;
    const parsed = JSON.parse(desk.blocks[0]!.text) as { mcpServers: { norr: { args: string[]; env: Record<string, string> } } };
    expect(parsed.mcpServers.norr.args).toEqual(["-y", "@norrfi/mcp"]);
    expect(parsed.mcpServers.norr.env).toEqual({ NORR_AGENT_TOKEN: "norr_agent_abc", NORR_MCP_URL: "https://x/mcp" });
    const onDefault = JSON.parse(mcpSnippets("https://mcp.norr.finance/mcp", "t", undefined, true).find((s) => s.client === "claude-desktop")!.blocks[0]!.text);
    expect(onDefault.mcpServers.norr.env).toEqual({ NORR_AGENT_TOKEN: "t" });
    const cursor = JSON.parse(mcpSnippets("https://x/mcp", "t").find((s) => s.client === "cursor")!.blocks[0]!.text);
    expect(cursor).toEqual({ mcpServers: { norr: { url: "https://x/mcp", headers: { Authorization: "Bearer t" } } } });
  });

  it("now that @norrfi/mcp is published, the default stdio blocks use it", () => {
    expect(mcpSnippets("https://mcp.norr.finance/mcp", "t").find((s) => s.client === "claude-desktop")!.blocks[0]!.text).toContain("@norrfi/mcp");
  });

  it("labels as tested only the paths we have run", () => {
    expect(mcpSnippets("https://x/mcp", null).filter((s) => s.status === "tested").map((s) => s.client)).toEqual(["any", "claude-code", "rest", "norr-agent"]);
    for (const s of mcpSnippets("https://x/mcp", null)) expect(s.statusNote.length).toBeGreaterThan(20);
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
