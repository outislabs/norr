import { checkAttestation, composeImages, type Check } from "@norr/shared";
import { useState } from "react";
import { isOffline, type Api } from "../lib/api";
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
 * The quote's signature chain (genuine Intel hardware) is not checked on this page yet: Phala's verification API
 * sends no CORS headers, so no web page can read its answer. The owner gets the quote to paste into Phala's
 * explorer instead, or runs the terminal script, which asks Phala's API directly.
 */
export function AttestationPanel({ api }: { api: Api }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [facts, setFacts] = useState<{ commit: string | null; composeHash?: string; appId?: string; images: string[]; quote: string } | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  async function run() {
    setBusy(true);
    setError(null);
    setOffline(false);
    setCopied("idle");
    try {
      const nonce = randomNonce();
      const [ev, info] = await Promise.all([api.attestation(nonce), api.appInfo()]);
      setChecks(await checkAttestation(nonce, ev, info));
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
          <li className="border-t border-line py-3">
            <p className="text-mute">
              <span aria-hidden="true">–</span> <span className="sr-only">not run: </span>The quote&apos;s signature chain is genuine
            </p>
            <p className="mt-1 break-words text-sm text-mute">
              Not run on this page. The checks above show the pieces agree with each other; this one shows genuine Intel hardware produced them. Copy the quote and paste it into Phala&apos;s TEE Attestation Explorer, which checks it against Intel&apos;s certificates.
            </p>
            {facts && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button type="button" className="btn btn-quiet min-h-10 px-4 text-sm" onClick={() => void copyQuote()}>
                  {copied === "copied" ? "Quote copied" : copied === "failed" ? "Copy failed" : "Copy the quote"}
                </button>
                <a href={QUOTE_EXPLORER} target="_blank" rel="noopener noreferrer" className="text-sm text-fg hover:text-mute">
                  Open the explorer ↗
                </a>
              </div>
            )}
          </li>
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
