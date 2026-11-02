// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceStatus } from "../lib/api";
import { Onboarding } from "./Onboarding";
import { Portfolio } from "./Portfolio";
import { statusPills } from "./StatusBar";
import { ValueChart } from "./ValueChart";
import { onboardingSteps } from "../lib/onboarding";

afterEach(cleanup);

const ok: ServiceStatus = { mock: false, pricing: "ready", shield: "ok", enclave: true, vaults: { total: 1, paused: 0 } };
const byId = (p: ReturnType<typeof statusPills>) => Object.fromEntries(p.map((x) => [x.id, x]));

describe("statusPills", () => {
  it("shows green only when each thing is actually fine", () => {
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
