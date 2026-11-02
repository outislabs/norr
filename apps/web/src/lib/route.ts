import { useEffect, useState } from "react";

export type Route = { name: "vaults" } | { name: "vault"; id: string; tab: "overview" | "fund" | "connect" | "rules" | "activity" | "approvals" } | { name: "verify" };
const TABS = ["overview", "fund", "connect", "rules", "activity", "approvals"] as const;

/** Hash routes: #/ , #/vault/<id>/<tab> , #/verify . Anything else is the vault list. */
export function parseRoute(path: string): Route {
  const parts = path.replace(/^#/, "").split("/").filter(Boolean);
  if (parts[0] === "verify") return { name: "verify" };
  if (parts[0] === "vault" && parts[1]) {
    const tab = TABS.find((t) => t === parts[2]) ?? "overview";
    return { name: "vault", id: decodeURIComponent(parts[1]), tab };
  }
  return { name: "vaults" };
}

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
