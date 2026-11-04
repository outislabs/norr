import { AttestationPanel } from "../components/AttestationPanel";
import type { Api } from "../lib/api";
import { useAsync } from "../lib/useAsync";

export function VerifyPage({ api, signedIn }: { api: Api; signedIn: boolean }) {
  // The owner-only parts (mode label, what you have done here) need a session; the attestation checks do not.
  const { data, error, loading } = useAsync(() => (signedIn ? api.verify() : Promise.resolve(null)), `verify-${signedIn}`);
  const audit = useAsync(() => (signedIn ? api.audit() : Promise.resolve(null)), `audit-${signedIn}`);
  // Public: how this deployment is set up, so anyone checking the enclave also sees what it does not check.
  const health = useAsync(() => api.health().catch(() => null), "verify-health");
  return (
    <section className="max-w-3xl">
      <h1 className="font-display text-3xl">Verify</h1>
      <div className="rule mt-3" />
      {!signedIn && (
        <p className="mt-6 text-mute">
          You do not need an account for this. Your browser asks the running service to prove which code and images it booted, on genuine Intel TDX hardware, and checks the answer itself.
        </p>
      )}
      {health.data && (
        <dl className="mt-6 grid grid-cols-[8rem_minmax(0,1fr)] gap-y-2 text-[15px]" data-testid="deployment-settings">
          <dt className="text-mute">Incident feed</dt>
          <dd>{health.data.incidentFeed === "not_configured" ? "Not configured (partner key pending). Trades that pass the rules and Scam Shield are not checked against the NEAR Intents incident feed; every answer says so." : "Active: checked for every trade that passes the rules, fail-closed."}</dd>
        </dl>
      )}
      {loading && signedIn && <p className="mt-6 text-mute">Loading…</p>}
      {error && <p role="alert" className="mt-6 text-alert">{error}</p>}
      {data && (
        <div className="mt-6">
          <p className={`font-display text-2xl ${data.attested ? "text-ok" : "text-accent"}`}>{data.attested ? "Running in a verified enclave" : "Not running in an enclave yet"}</p>
          <p className="mt-2 text-mute">{data.note}</p>
          <dl className="mt-5 grid grid-cols-[8rem_1fr] gap-y-2 text-[15px]">
            <dt className="text-mute">Mode</dt>
            <dd>{data.mode === "mock" ? "Mock (no funds, fixed prices)" : "Live"}</dd>
            <dt className="text-mute">Code version</dt>
            <dd className="mono">
              {data.commit ? data.commit.slice(0, 12) : "not reported"}
              {data.commit && data.dirty ? <span className="text-accent"> (uncommitted changes: this hash does not fully describe the running code)</span> : null}
            </dd>
          </dl>
        </div>
      )}
      {(!signedIn || data?.attested) && <AttestationPanel api={api} />}
      {signedIn && (
        <>
          <h2 className="mt-10 font-display text-xl">What you have done here</h2>
          {audit.data && audit.data.audit.length === 0 && <p className="mt-2 text-mute">No actions yet. Pausing, resuming, rule changes and tokens you create are listed here.</p>}
          <ul className="mt-2">
            {audit.data?.audit.map((a, i) => (
              <li key={`${a.at}-${i}`} className="flex justify-between gap-3 border-t border-line py-2 text-[15px]">
                <span>{a.action}{a.vaultId ? ` (${a.vaultId})` : ""}</span>
                <time className="text-sm text-mute" dateTime={a.at}>{a.at.slice(0, 19).replace("T", " ")}Z</time>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
