import { useEffect, useState } from "react";

export type Route = { name: "vaults" } | { name: "setup"; id: string } | { name: "authorize"; rid: string } | { name: "vault"; id: string; tab: "overview" | "fund" | "connect" | "rules" | "withdraw" | "activity" | "approvals"; asset?: string } | { name: "verify" };
const TABS = ["overview", "fund", "connect", "rules", "withdraw", "activity", "approvals"] as const;

/** Hash routes: #/ , #/vault/<id>/<tab> , #/verify . Anything else is the vault list. */
export function parseRoute(path: string): Route {
  const parts = path.replace(/^#/, "").split("/").filter(Boolean);
  if (parts[0] === "verify") return { name: "verify" };
  if (parts[0] === "setup" && parts[1]) return { name: "setup", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "authorize" && parts[1]) return { name: "authorize", rid: decodeURIComponent(parts[1]) };
  if (parts[0] === "vault" && parts[1]) {
    const tab = TABS.find((t) => t === parts[2]) ?? "overview";
    // #/vault/<id>/withdraw/<asset id>: the withdraw form with that token chosen (from "Withdraw to my wallet").
    return { name: "vault", id: decodeURIComponent(parts[1]), tab, ...(tab === "withdraw" && parts[3] ? { asset: decodeURIComponent(parts[3]) } : {}) };
  }
  return { name: "vaults" };
}

/** The withdraw form with one token already chosen. */
export const withdrawHref = (id: string, assetId: string): string => `#/vault/${encodeURIComponent(id)}/withdraw/${encodeURIComponent(assetId)}`;

export const setupHref = (id: string): string => `#/setup/${encodeURIComponent(id)}`;
export const vaultHref = (id: string, tab: string = "overview"): string => `#/vault/${encodeURIComponent(id)}/${tab}`;

export function useHashPath(): string {
  const [h, setH] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setH(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return h.replace(/^#/, "") || "/";
}
