// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, ServiceStatus } from "../lib/api";
import { AssetCheckPanel } from "./AssetCheckPanel";
import { ConnectAgent } from "./ConnectAgent";
import { VerifyPage } from "../pages/VerifyPage";
import { Onboarding } from "./Onboarding";
import { PnlPanel, signedUsd } from "./PnlPanel";
import { Portfolio } from "./Portfolio";
import { statusPills } from "./StatusBar";
import { ValueChart } from "./ValueChart";
import { onboardingSteps } from "../lib/onboarding";

afterEach(cleanup);

const ok: ServiceStatus = { mock: false, pricing: "ready", shield: "ok", enclave: true, vaults: { total: 1, paused: 0 } };
const byId = (p: ReturnType<typeof statusPills>) => Object.fromEntries(p.map((x) => [x.id, x]));

describe("statusPills", () => {
  it("marks a pill fine only when each thing is actually fine", () => {
    const p = byId(statusPills("pass", ok));
    expect(Object.values(p).every((x) => x.tone === "ok")).toBe(true);
    expect(p.enclave!.label).toBe("Enclave verified");
  });

  it("says plainly when the enclave check failed, when there is no TEE, and while it is still checking", () => {
    expect(statusPills("fail", null)[0]).toMatchObject({ tone: "bad", label: "Enclave check failed" });
    expect(statusPills("none", null)[0]).toMatchObject({ tone: "warn", label: "Not in an enclave" });
    expect(statusPills("checking", null)[0]).toMatchObject({ tone: "idle" });
    expect(statusPills("checking", null)).toHaveLength(1); // no service facts yet: no guessing
  });

  it("treats an unreachable service as offline (the engine runs on demand), not as a failed check", () => {
    expect(statusPills("offline", null)).toEqual([expect.objectContaining({ id: "enclave", label: "Offline", tone: "idle", href: "#/verify" })]);
  });

  it("labels an incident feed that is not configured, without calling it a failure", () => {
    const p = byId(statusPills("pass", { ...ok, shield: "not_configured" }));
    expect(p.shield).toMatchObject({ tone: "warn", label: "Incident feed: not configured" });
    expect(p.shield!.title).toContain("partner key pending");
  });

  it("explains pricing retrying and an unreadable Shield feed as the reason trades are blocked", () => {
    const p = byId(statusPills("pass", { ...ok, pricing: "retrying", shield: "unavailable" }));
    expect(p.pricing).toMatchObject({ tone: "warn", label: "Pricing retrying" });
    expect(p.pricing!.title).toMatch(/blocked/);
    expect(p.shield).toMatchObject({ tone: "bad", label: "Shield unavailable" });
    expect(p.shield!.title).toMatch(/fail closed/);
    expect(byId(statusPills("pass", { ...ok, shield: "incidents" })).shield).toMatchObject({ tone: "warn" });
  });

  it("reports paused vaults, all or some", () => {
    expect(byId(statusPills("pass", { ...ok, vaults: { total: 1, paused: 1 } })).vaults).toMatchObject({ tone: "bad", label: "Paused" });
    expect(byId(statusPills("pass", { ...ok, vaults: { total: 3, paused: 1 } })).vaults).toMatchObject({ tone: "bad", label: "1 paused" });
    expect(byId(statusPills("pass", { ...ok, vaults: { total: 0, paused: 0 } })).vaults).toMatchObject({ label: "No vaults" });
  });
});

describe("Onboarding", () => {
  it("marks the next step and links each open step to its tab", () => {
    render(<Onboarding vaultId="demo" steps={onboardingSteps({ totalUsd: 0, tokenIssued: false, hasActivity: false, rulesReviewed: false })} />);
    expect(screen.getByText("Fund it")).toBeTruthy();
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toEqual(["#/vault/demo/fund", "#/vault/demo/rules", "#/vault/demo/connect"]);
    expect(screen.getAllByText("Do this")).toHaveLength(1);
  });

  it("renders nothing once everything is done", () => {
    const { container } = render(<Onboarding vaultId="demo" steps={onboardingSteps({ totalUsd: 5, tokenIssued: true, hasActivity: false, rulesReviewed: true })} />);
    expect(container.textContent).toBe("");
  });
});

describe("Portfolio", () => {
  it("an empty vault explains why and offers the Fund tab", () => {
    render(<Portfolio portfolio={{ holdings: [], totalUsd: 0, byClass: { crypto: 0, equity: 0 } }} fundHref="#/vault/demo/fund" />);
    expect(screen.getByText("Nothing in the vault yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Fund the vault" }).getAttribute("href")).toBe("#/vault/demo/fund");
  });

  it("splits value by kind and by layer, naming every slice", () => {
    render(
      <Portfolio
        portfolio={{ totalUsd: 30, byClass: { crypto: 10, equity: 20 }, holdings: [{ symbol: "USDC", class: "crypto", amount: 10, valueUsd: 10, layer: "confidential" }, { symbol: "NVDAon", class: "equity", amount: 0.1, valueUsd: 20, layer: "public" }] }}
      />,
    );
    expect(screen.getByRole("img", { name: /Crypto \$10\.00, Tokenized stocks \$20\.00/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Confidential \$10\.00, Public \$20\.00/ })).toBeTruthy();
  });
});

describe("ValueChart", () => {
  it("says what it is waiting for when there is no history, and draws a labelled line when there is", () => {
    const { rerender } = render(<ValueChart points={[]} />);
    expect(screen.getByText(/once there are two/)).toBeTruthy();
    rerender(<ValueChart points={[{ t: Date.UTC(2026, 10, 3, 12), totalUsd: 10, cryptoUsd: 10, equityUsd: 0 }, { t: Date.UTC(2026, 10, 3, 13), totalUsd: 12, cryptoUsd: 12, equityUsd: 0 }]} />);
    expect(screen.getByRole("img", { name: /from \$10\.00 to \$12\.00/ })).toBeTruthy();
    expect(screen.getByText(/\+\$2\.00/)).toBeTruthy();
  });
});

describe("PnlPanel", () => {
  const pnl = {
    since: "2026-11-03T12:00:00.000Z",
    scope: "Positions Norr bought for this vault.",
    assets: [
      { asset: "SOL", trades: 2, boughtUsd: 10, soldUsd: 4, realizedUsd: -0.12, qtyHeld: 0.06, costBasisUsd: 6, avgCostUsd: 100, priceUsd: 110, marketValueUsd: 6.6, unrealizedUsd: 0.6 },
      { asset: "ODD", trades: 1, boughtUsd: 5, soldUsd: 0, realizedUsd: 0, qtyHeld: 3, costBasisUsd: 5, avgCostUsd: 1.6667, priceUsd: null, marketValueUsd: null, unrealizedUsd: null },
    ],
    totals: { boughtUsd: 15, soldUsd: 4, realizedUsd: -0.12, unrealizedUsd: 0.6, totalUsd: 0.48, costBasisUsd: 11 },
    unpriced: ["ODD"],
  };

  it("signs amounts in words, not colour", () => {
    expect(signedUsd(1.5)).toBe("+$1.50");
    expect(signedUsd(-0.12)).toBe("−$0.12");
    expect(signedUsd(0)).toBe("$0.00");
  });

  it("shows totals, a row per asset, and says which holdings have no price", () => {
    render(<PnlPanel pnl={pnl} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("+$0.48");
    expect(text).toContain("−$0.12");
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(text).toContain("no price");
    expect(text).toContain("No current price for ODD");
    expect(text).toContain("Since 2026-11-03");
  });

  it("says plainly when there are no trades yet", () => {
    render(<PnlPanel pnl={{ ...pnl, assets: [], since: null, unpriced: [] }} />);
    expect(document.body.textContent).toContain("No trades yet");
  });
});

describe("ConnectAgent", () => {
  it("leads with any MCP client, shows the token alone with a Copy button, and labels every tab tested or not", async () => {
    const api = { issueToken: vi.fn(async () => ({ token: "norr_agent_abc123" })), revokeTokens: vi.fn() } as unknown as Api;
    render(<ConnectAgent api={api} vaultId="demo" mcpUrl="https://mcp.example/mcp" apiUrl="https://api.example" />);
    expect(document.body.textContent).toContain("Works with any MCP-compatible agent, or any code that can call the REST API.");
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Any MCP client", "Claude Code", "Claude Desktop", "Cursor", "ChatGPT / OpenAI", "REST API", "Norr agent"]);
    expect(screen.getByRole("tab", { name: "Any MCP client" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Create an agent token" }));
    const box = await screen.findByTestId("agent-token");
    expect(box.querySelector("pre")!.textContent).toBe("norr_agent_abc123");
    expect(within(box).getByRole("button", { name: "Copy" })).toBeTruthy();

    for (const t of screen.getAllByRole("tab")) {
      fireEvent.click(t);
      expect(screen.getByRole("tabpanel").textContent).toMatch(/^(tested|not yet tested)/);
    }
    fireEvent.click(screen.getByRole("tab", { name: "REST API" }));
    expect(screen.getByRole("tabpanel").textContent).toContain("curl -X POST https://api.example/v1/trade");
    expect(screen.getByRole("tabpanel").textContent).toContain("Bearer norr_agent_abc123");
  });
});

describe("VerifyPage", () => {
  it("shows anyone, signed in or not, that the incident feed is not configured on this deployment", async () => {
    const api = { health: vi.fn(async () => ({ ok: true, mock: false, incidentFeed: "not_configured" })) } as unknown as Api;
    render(<VerifyPage api={api} signedIn={false} />);
    const row = await screen.findByTestId("deployment-settings");
    expect(row.textContent).toContain("Not configured (partner key pending)");
  });
});

describe("AssetCheckPanel", () => {
  it("shows Scam Shield's verdict with the GoPlus contract findings, or why the contract was not checked", async () => {
    const api = {
      checkAsset: vi.fn(async () => ({
        found: true, class: "crypto", ticker: "RUGPULL",
        versions: [{ symbol: "RUGPULL", issuer: null, chain: "sol", shieldBlocked: null, risk: { score: 100, level: "high", reasons: ["Very low liquidity ($3,200).", "Mint authority is active: more tokens can be minted."], contract: { source: "goplus", status: "ok", trusted: false, findings: ["Mint authority is active: more tokens can be minted.", "Freeze authority is active: holders' accounts can be frozen."] } } }],
        incidentFeed: { status: "not_configured", note: "Incident feed: not configured (partner key pending)" },
      })),
    } as unknown as Api;
    render(<AssetCheckPanel api={api} vaultId="demo" />);
    fireEvent.change(screen.getByLabelText("Token to check"), { target: { value: "RUGPULL" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    const box = await screen.findByTestId("asset-check");
    expect(box.textContent).toContain("high risk · 100/100");
    expect(box.textContent).toContain("Checked by GoPlus");
    expect(box.textContent).toContain("Freeze authority is active");
    expect(box.textContent).toContain("Incident feed: not configured (partner key pending)");
    expect(api.checkAsset).toHaveBeenCalledWith("demo", "RUGPULL");
  });
});
