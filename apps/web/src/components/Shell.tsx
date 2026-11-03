import { useRef, type ReactNode } from "react";
import { shortId } from "../lib/format";
import type { Api } from "../lib/api";
import { KillSwitch } from "./KillSwitch";
import { StatusBar } from "./StatusBar";

/** The norr wordmark (the same file as the landing page's), linking home. */
export function Wordmark({ className = "h-5" }: { className?: string }) {
  return (
    <a href="#/" aria-label="Norr home" className="flex items-center">
      <img src="/brand/norr-wordmark.png" alt="Norr" width={56} height={20} className={`block w-auto ${className}`} />
    </a>
  );
}

/**
 * The mobile menu button and its sheet, the landing page's pattern: the native Popover API handles open/close,
 * Escape and tapping outside. Links in the sheet stay on this page (hash routes), so a tap also closes it.
 */
function MobileMenu({ children }: { children: (close: () => void) => ReactNode }) {
  const sheet = useRef<HTMLDivElement>(null);
  const close = () => sheet.current?.hidePopover?.();
  return (
    <>
      <button type="button" className="menu-btn sm:hidden" popoverTarget="menu" aria-label="Menu" aria-controls="menu">
        <span className="menu-icon" aria-hidden="true" />
      </button>
      <div id="menu" ref={sheet} popover="auto" className="menu-sheet">
        {children(close)}
      </div>
    </>
  );
}

const navClass = (active: boolean) => `text-sm ${active ? "text-fg" : "text-mute hover:text-fg"}`;

export function Shell({ api, version, account, route, onSignOut, onPauseAll, children }: { api: Api; version: number; account: string; route: string; onSignOut: () => void; onPauseAll: () => Promise<void>; children: ReactNode }) {
  const onVaults = route === "/" || route.startsWith("/vault");
  const onVerify = route === "/verify";
  return (
    <div className="mx-auto min-h-screen max-w-3xl px-4 pb-24 sm:px-6 lg:max-w-6xl">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line py-4 sm:py-6">
        <div className="flex items-center gap-8">
          <Wordmark />
          <nav className="hidden items-center gap-6 sm:flex" aria-label="Main">
            <a href="#/" aria-current={onVaults ? "page" : undefined} className={navClass(onVaults)}>Vaults</a>
            <a href="#/verify" aria-current={onVerify ? "page" : undefined} className={navClass(onVerify)}>Verify</a>
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-5">
          <span className="mono hidden text-xs text-dim md:inline" title={account}>{shortId(account, 14, 6)}</span>
          <button type="button" className="hidden text-sm text-mute hover:text-fg sm:inline" onClick={onSignOut}>
            Sign out
          </button>
          <KillSwitch onPauseAll={onPauseAll} />
          <MobileMenu>
            {(close) => (
              <nav aria-label="Menu" className="flex flex-col">
                <a href="#/" onClick={close} aria-current={onVaults ? "page" : undefined}>Vaults</a>
                <a href="#/verify" onClick={close} aria-current={onVerify ? "page" : undefined}>Verify</a>
                <span className="mono text-xs text-dim" title={account}>Signed in as {shortId(account, 14, 6)}</span>
                <button type="button" onClick={() => (close(), onSignOut())}>Sign out</button>
              </nav>
            )}
          </MobileMenu>
        </div>
      </header>
      <StatusBar api={api} version={version} />
      <main>{children}</main>
    </div>
  );
}

/** The page chrome for a signed-out visitor: just the proof, and a way in. */
export function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-3xl px-4 pb-24 sm:px-6 lg:max-w-6xl">
      <header className="mb-8 flex items-center justify-between gap-4 border-b border-line py-4 sm:py-6">
        <Wordmark />
        <a href="#/" className="btn btn-solid min-h-10 px-[18px] text-sm">
          Sign in
        </a>
      </header>
      <main>{children}</main>
    </div>
  );
}
