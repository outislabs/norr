import { checkAttestation, composeImages, verifyQuoteWithPhala, type Check } from "@norr/shared";
import { useState } from "react";
import { isOffline, type Api } from "../lib/api";
import { Offline } from "./Offline";

const MARK = { pass: "✓", fail: "✕", skipped: "–" } as const;
const TONE = { pass: "text-fg", fail: "text-fg", skipped: "text-dim" } as const;

const randomNonce = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Fetches the service's attestation with a fresh nonce and runs the checks here, in the browser, on the evidence
 * itself. The service's own "attested" label is not part of the result.
 */
export function AttestationPanel({ api }: { api: Api }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [facts, setFacts] = useState<{ commit: string | null; composeHash?: string; appId?: string; images: string[]; quote: string } | null>(null);

  async function run(withPhala: boolean) {
    setBusy(true);
    setError(null);
    setOffline(false);
    try {
      const nonce = randomNonce();
      const [ev, info] = await Promise.all([api.attestation(nonce), api.appInfo()]);
      const base = await checkAttestation(nonce, ev, info);
      setChecks(withPhala ? [...base, await verifyQuoteWithPhala(ev.quote)] : base);
      let images: string[] = [];
      try {
        images = composeImages(info.appCompose).map((i) => i.image);
      } catch {
        /* the images check already reports it */
      }
      setFacts({ commit: ev.commit, composeHash: info.composeHash, appId: info.appId, images, quote: ev.quote });
    } catch (e) {
      setChecks(null);
      setFacts(null);
      if (isOffline(e)) setOffline(true);
      else setError(e instanceof Error ? e.message : "Could not fetch the attestation.");
    } finally {
      setBusy(false);
    }
  }

  const signature = checks?.find((c) => c.id === "quote-signature");
  return (
    <div className="mt-8 max-w-2xl">
      <h2 className="font-display text-xl">Check the enclave yourself</h2>
      <p className="mt-1 text-sm text-mute">Your browser asks the service for a fresh attestation and checks it. Nothing below is the service&apos;s own word.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" className="btn btn-solid" disabled={busy} onClick={() => void run(false)}>
          {busy ? "Checking…" : "Check attestation"}
        </button>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void run(true)} title="Sends the quote to Phala's verification service">
          Check, and verify the signature with Phala
        </button>
      </div>
      {offline && <div className="mt-5"><Offline onVerifyPage /></div>}
      {error && <p role="alert" className="mt-3 border-l border-line-strong pl-4 text-fg">{error}</p>}
      {checks && (
        <ul className="mt-5 flex flex-col">
          {checks.map((c) => (
            <li key={c.id} className="border-t border-line py-3">
              <p className={TONE[c.status]}>
                <span aria-hidden="true">{MARK[c.status]}</span> <span className="sr-only">{c.status}: </span>
                {c.label}
              </p>
              <p className="mt-1 whitespace-pre-line break-all text-sm text-mute">{c.detail}</p>
            </li>
          ))}
          {!signature && (
            <li className="border-t border-line py-3">
              <p className="text-mute">
                <span aria-hidden="true">–</span> <span className="sr-only">not run: </span>The quote&apos;s signature chain is genuine
              </p>
              <p className="mt-1 text-sm text-mute">Not run. Until it passes, the checks above show the pieces agree with each other, not that genuine hardware produced them. Use the second button, or run <span className="mono">dcap-qvl</span> yourself.</p>
            </li>
          )}
        </ul>
      )}
      {facts && (
        <dl className="mt-5 grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-mute">Git commit</dt>
          <dd className="mono break-all">{facts.commit ?? "not reported"}</dd>
          <dt className="text-mute">Compose hash</dt>
          <dd className="mono break-all">{facts.composeHash ?? "not reported"}</dd>
          <dt className="text-mute">App id</dt>
          <dd className="mono break-all">{facts.appId ?? "not reported"}</dd>
          <dt className="text-mute">Images</dt>
          <dd className="mono break-all">{facts.images.length ? facts.images.join("\n") : "none found"}</dd>
        </dl>
      )}
      <p className="mt-5 text-sm text-mute">
        To repeat this without the dashboard: <span className="mono">pnpm exec tsx scripts/verify-attestation.mts &lt;service URL&gt;</span>. Passing proves which code and images started on genuine hardware. It does not show what the secrets are, and the custody provider&apos;s own limits are unchanged.
      </p>
    </div>
  );
}
