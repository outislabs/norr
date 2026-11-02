import { useState } from "react";
import type { Api, SessionInfo } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { demoSignIn, walletSignIn } from "../lib/signin";

export function SignInPage({ api, onSession }: { api: Api; onSession: (s: SessionInfo) => void }) {
  const health = useAsync(() => api.health(), "health");
  const [busy, setBusy] = useState<"wallet" | "demo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: "wallet" | "demo") => {
    setBusy(kind);
    setError(null);
    try {
      const mockOwner = health.data?.mockOwner;
      onSession(kind === "demo" && mockOwner ? await demoSignIn(api, mockOwner) : await walletSignIn(api));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <h1 className="font-display text-6xl tracking-tight">Norr</h1>
      <p className="mt-3 font-display text-xl text-brass">Give your AI money without giving it the keys.</p>
      <p className="mt-6 text-mist">Sign in with your NEAR wallet. You sign one message that proves the account is yours; it does not move funds and gives Norr no access to them.</p>

      <div className="mt-8 flex flex-col gap-3">
        <button type="button" className="btn btn-solid" disabled={busy !== null} onClick={() => run("wallet")}>
          {busy === "wallet" ? "Waiting for your wallet…" : "Sign in with a NEAR wallet"}
        </button>
        {health.data?.mock && (
          <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => run("demo")}>
            {busy === "demo" ? "Signing in…" : "Use the demo owner (mock mode, no funds)"}
          </button>
        )}
      </div>
      {health.error && (
        <p role="alert" className="mt-6 text-rust">
          {health.error}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-6 text-rust">
          {error}
        </p>
      )}
      <p className="mt-8 text-sm text-mist">
        Not ready to sign in? <a href="#/verify" className="underline decoration-line underline-offset-4 hover:text-ivory">Check the enclave first</a>: no account needed.
      </p>
      {health.data?.mock && <p className="mt-4 text-sm text-mist">This service is running in mock mode: prices are fixed, nothing leaves your machine, and the demo owner needs no wallet.</p>}
    </div>
  );
}
