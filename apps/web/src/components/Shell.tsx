import type { ReactNode } from "react";
import { shortId } from "../lib/format";
import { KillSwitch } from "./KillSwitch";

export function Shell({ account, route, onSignOut, onPauseAll, children }: { account: string; route: string; onSignOut: () => void; onPauseAll: () => Promise<void>; children: ReactNode }) {
  const link = (href: string, label: string, active: boolean) => (
    <a href={href} aria-current={active ? "page" : undefined} className={`pb-1 text-[15px] ${active ? "border-b border-brass text-ivory" : "text-mist hover:text-ivory"}`}>
      {label}
    </a>
  );
  return (
    <div className="mx-auto min-h-screen max-w-2xl px-4 pb-24 pt-5">
      <header className="mb-8">
        <div className="flex items-baseline justify-between gap-4">
          <a href="#/" className="font-display text-4xl font-normal tracking-tight text-ivory">
            Norr
          </a>
          <div className="flex items-baseline gap-3 text-sm text-mist">
            <span className="mono" title={account}>
              {shortId(account, 14, 6)}
            </span>
            <button type="button" className="underline decoration-line underline-offset-4 hover:text-ivory" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-3">
          <nav className="flex gap-6" aria-label="Main">
            {link("#/", "Vaults", route === "/" || route.startsWith("/vault"))}
            {link("#/verify", "Verify", route === "/verify")}
          </nav>
          <KillSwitch onPauseAll={onPauseAll} />
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
