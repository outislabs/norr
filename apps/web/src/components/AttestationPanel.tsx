import { checkAttestation, composeImages, type Check } from "@norr/shared";
import { useState } from "react";
import { isOffline, type Api } from "../lib/api";
import { loadQvl, verifyQuoteSignature, type Qvl } from "../lib/qvl";
import { Offline } from "./Offline";

const MARK = { pass: "✓", fail: "✕", skipped: "–" } as const;
const TONE = { pass: "text-fg", fail: "text-fg", skipped: "text-dim" } as const;

/** Phala's public TEE Attestation Explorer: paste a hex quote and it checks the signature chain against Intel's. */
export const QUOTE_EXPLORER = "https://proof.t16z.com/";

const randomNonce = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A check's detail mixes sentences with digests and hashes. Sentences wrap at word boundaries; a line that is a
 * single long token (an image reference, a hash) is shown in mono and may break anywhere, so it never overflows.
 */
export function DetailText({ text }: { text: string }) {
  return (
    <div className="mt-1 text-sm text-mute">
      {text.split("\n").map((line, i) =>
        /^\S{24,}$/.test(line.trim()) ? (
          <p key={i} className="mono break-all text-xs leading-relaxed">{line.trim()}</p>
        ) : (
          <p key={i} className="break-words">{line}</p>
        ),
      )}
    </div>
  );
}

/**
 * Fetches the service's attestation with a fresh nonce and runs the checks here, in the browser, on the evidence
 * itself. The service's own "attested" label is not part of the result.
 *
 * The seventh check, the quote's signature chain (genuine Intel hardware), also runs here: dcap-qvl in WebAssembly
 * verifies the quote against Intel's root certificate (see lib/qvl.ts). If that cannot run, the quote can be
 * copied into Phala's explorer, or checked with the terminal script.
 */
export function AttestationPanel({ api, qvl = loadQvl }: { api: Api; qvl?: () => Promise<Qvl> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [facts, setFacts] = useState<{ commit: string | null; composeHash?: string; appId?: string; images: string[]; quote: string } | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [signing, setSigning] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    setOffline(false);
    setCopied("idle");
    try {
      const nonce = randomNonce();
      const [ev, info] = await Promise.all([api.attestation(nonce), api.appInfo()]);
      const base = await checkAttestation(nonce, ev, info);
      setChecks(base);
      let images: string[] = [];
      try {
        images = composeImages(info.appCompose).map((i) => i.image);
      } catch {
        /* the images check already reports it */
      }
      setFacts({ commit: ev.commit, composeHash: info.composeHash, appId: info.appId, images, quote: ev.quote });
      // The signature chain, verified in this browser against Intel's root certificate.
      setSigning(true);
      const signature = await qvl().then(
        (v) => verifyQuoteSignature(ev.quote, v),
        () => ({ id: "quote-signature" as const, label: "The quote's signature chain is genuine", status: "skipped" as const, detail: "The verifier could not be loaded in this browser, so the signature was not checked. Copy the quote into the explorer below." }),
      );
      setChecks([...base, signature]);
    } catch (e) {
      setChecks(null);
      setFacts(null);
      if (isOffline(e)) setOffline(true);
      else setError(e instanceof Error ? e.message : "Could not fetch the attestation.");
    } finally {
      setBusy(false);
      setSigning(false);
    }
  }

  const copyQuote = async () => {
    try {
      await navigator.clipboard.writeText(facts!.quote.replace(/^0x/i, ""));
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div className="mt-8 max-w-2xl">
      <h2 className="font-display text-xl">Check the enclave yourself</h2>
      <p className="mt-1 text-sm text-mute">Your browser asks the service for a fresh attestation and checks it. Nothing below is the service&apos;s own word.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" className="btn btn-solid" disabled={busy} onClick={() => void run()}>
          {busy ? "Checking…" : "Check attestation"}
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
              <DetailText text={c.detail} />
            </li>
          ))}
          {signing && (
            <li className="border-t border-line py-3 text-mute" role="status">
              <span aria-hidden="true">…</span> Checking the quote&apos;s signature against Intel&apos;s certificates
            </li>
          )}
          {facts && !signing && checks.find((c) => c.id === "quote-signature")?.status !== "pass" && (
            <li className="border-t border-line py-3">
              <p className="break-words text-sm text-mute">Check the signature elsewhere: copy the quote into Phala&apos;s TEE Attestation Explorer, which checks it against Intel&apos;s certificates.</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button type="button" className="btn btn-quiet min-h-10 px-4 text-sm" onClick={() => void copyQuote()}>
                  {copied === "copied" ? "Quote copied" : copied === "failed" ? "Copy failed" : "Copy the quote"}
                </button>
                <a href={QUOTE_EXPLORER} target="_blank" rel="noopener noreferrer" className="text-sm text-fg hover:text-mute">
                  Open the explorer ↗
                </a>
              </div>
            </li>
          )}
        </ul>
      )}
      {facts && (
        <dl className="mt-5 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          <dt className="text-mute">Git commit</dt>
          <dd className="mono break-all">{facts.commit ?? "not reported"}</dd>
          <dt className="text-mute">Compose hash</dt>
          <dd className="mono break-all">{facts.composeHash ?? "not reported"}</dd>
          <dt className="text-mute">App id</dt>
          <dd className="mono break-all">{facts.appId ?? "not reported"}</dd>
          <dt className="text-mute">Images</dt>
          <dd className="mono whitespace-pre-line break-all">{facts.images.length ? facts.images.join("\n") : "none found"}</dd>
        </dl>
      )}
      <p className="mt-5 break-words text-sm text-mute">
        To repeat everything from a terminal, including the signature check: <span className="mono">pnpm exec tsx scripts/verify-attestation.mts &lt;service URL&gt;</span>. Passing proves which code and images started on genuine hardware. It does not show what the secrets are, and the custody provider&apos;s own limits are unchanged.
      </p>
    </div>
  );
}
