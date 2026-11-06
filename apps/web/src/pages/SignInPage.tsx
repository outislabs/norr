import { useState } from "react";
import { Offline } from "../components/Offline";
import { Wordmark } from "../components/Shell";
import { isOffline, type Api, type SessionInfo } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { demoSignIn, walletSignIn } from "../lib/signin";

/** Where "No NEAR wallet?" points: HOT Wallet, multichain, which gives a NEAR account next to EVM and Solana ones. */
export const HOT_WALLET = "https://hot-labs.org/wallet/";

/**
 * One column on phones; from 900px a split screen: the headline on the left, a compact sign-in panel on the right.
 * Copy is deliberately minimal. What signing in does (one NEP-413 message, no transaction) is stated in one line.
 */
export function SignInPage({ api, onSession }: { api: Api; onSession: (s: SessionInfo) => void }) {
  const health = useAsync(() => api.health(), "health");
  const [busy, setBusy] = useState<"wallet" | "demo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Wallets that are configured but did not start in this browser, said instead of silently missing from the picker. */
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (kind: "wallet" | "demo") => {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const mockOwner = health.data?.mockOwner;
      onSession(kind === "demo" && mockOwner ? await demoSignIn(api, mockOwner) : await walletSignIn(api, { onNotice: setNotice }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setBusy(null);
    }
  };
  const offline = isOffline(health.error);
  return (
    <div className="grid min-h-screen content-center gap-12 px-6 py-12 min-[900px]:grid-cols-[1.25fr_1fr] min-[900px]:content-stretch min-[900px]:gap-0 min-[900px]:p-0">
      <section className="relative flex flex-col gap-10 min-[900px]:justify-center min-[900px]:px-10 min-[1200px]:px-20">
        <div className="min-[900px]:absolute min-[900px]:left-10 min-[900px]:top-10 min-[1200px]:left-20">
          <Wordmark className="h-6 min-[900px]:h-7" />
        </div>
        <h1 className="font-display max-w-[15ch] text-[40px] leading-[1.02] tracking-[-0.045em] [text-wrap:balance] min-[900px]:max-w-none min-[900px]:text-[clamp(36px,3.7vw,64px)] min-[900px]:leading-[0.98]">
          Privacy-first trading <br className="hidden min-[900px]:inline" />
          for AI agents.
        </h1>
      </section>

      <section aria-label="Sign in" className="flex flex-col justify-center min-[900px]:border-l min-[900px]:border-line min-[900px]:px-10 min-[1200px]:px-20">
        <div className="flex w-full max-w-sm flex-col gap-3">
          <button type="button" className="btn btn-solid min-h-12" disabled={busy !== null} onClick={() => run("wallet")}>
            {busy === "wallet" ? "Waiting for your wallet…" : "Sign in with a NEAR wallet"}
          </button>
          {health.data?.mock && (
            <button type="button" className="btn min-h-12" disabled={busy !== null} onClick={() => run("demo")}>
              {busy === "demo" ? "Signing in…" : "Use the demo owner"}
            </button>
          )}
          <p className="mt-1 text-sm text-mute">Signing in moves no funds.</p>
          {/* Owning a vault needs a NEAR account (full EVM and Solana sign-in is on the roadmap); HOT Wallet gives one alongside EVM and Solana. */}
          <a href={HOT_WALLET} target="_blank" rel="noopener noreferrer" className="text-sm text-mute hover:text-fg">
            No NEAR wallet? HOT works with your EVM or Solana setup →
          </a>
          {offline && <div className="mt-5"><Offline compact /></div>}
          {health.error && !offline && <p role="alert" className="mt-5 border-l border-line-strong pl-4 text-sm text-fg">{health.error}</p>}
          {notice && <p role="status" className="mt-5 border-l border-line-strong pl-4 text-sm text-mute">{notice}</p>}
          {error && <p role="alert" className="mt-5 border-l border-line-strong pl-4 text-sm text-fg">{error}</p>}
          <div className="mt-6 flex items-center justify-between gap-4">
            <a href="#/verify" className="text-sm text-fg hover:text-mute">Verify the enclave →</a>
            {health.data?.mock && <span className="eyebrow" title="Prices are fixed and nothing leaves this machine; the demo owner needs no wallet.">Mock mode · no funds</span>}
          </div>
        </div>
      </section>
    </div>
  );
}
