import type { Api } from "../lib/api";
import { useAsync } from "../lib/useAsync";

export function VerifyPage({ api }: { api: Api }) {
  const { data, error, loading } = useAsync(() => api.verify(), "verify");
  const audit = useAsync(() => api.audit(), "audit");
  return (
    <section>
      <h1 className="font-display text-3xl">Verify</h1>
      <div className="rule mt-3" />
      {loading && <p className="mt-6 text-mist">Loading…</p>}
      {error && <p role="alert" className="mt-6 text-rust">{error}</p>}
      {data && (
        <div className="mt-6">
          <p className={`font-display text-2xl ${data.attested ? "text-verdigris" : "text-brass"}`}>{data.attested ? "Running in a verified enclave" : "Not running in an enclave yet"}</p>
          <p className="mt-2 text-mist">{data.note}</p>
          <dl className="mt-5 grid grid-cols-[8rem_1fr] gap-y-2 text-[15px]">
            <dt className="text-mist">Mode</dt>
            <dd>{data.mode === "mock" ? "Mock (no funds, fixed prices)" : "Live"}</dd>
            <dt className="text-mist">Code version</dt>
            <dd className="mono">
              {data.commit ? data.commit.slice(0, 12) : "not reported"}
              {data.commit && data.dirty ? <span className="text-brass"> (uncommitted changes: this hash does not fully describe the running code)</span> : null}
            </dd>
          </dl>
        </div>
      )}
      <h2 className="mt-10 font-display text-xl">What you have done here</h2>
      {audit.data && audit.data.audit.length === 0 && <p className="mt-2 text-mist">No actions yet.</p>}
      <ul className="mt-2">
        {audit.data?.audit.map((a, i) => (
          <li key={`${a.at}-${i}`} className="flex justify-between gap-3 border-t border-line py-2 text-[15px]">
            <span>{a.action}{a.vaultId ? ` (${a.vaultId})` : ""}</span>
            <time className="text-sm text-mist" dateTime={a.at}>{a.at.slice(0, 19).replace("T", " ")}Z</time>
          </li>
        ))}
      </ul>
    </section>
  );
}
