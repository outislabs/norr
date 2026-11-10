import { checkAttestation } from "@norr/shared";
import { useEffect, useState } from "react";
import { ApiError, isOffline, type Api, type ServiceStatus } from "../lib/api";

type Tone = "ok" | "warn" | "bad" | "idle";
// Black and white: the word carries the meaning; the mark only reinforces it (filled = fine, grey = attention, ring = stopped).
const DOT: Record<Tone, string> = { ok: "bg-fg", warn: "bg-mute", bad: "border border-fg", idle: "bg-dim" };

const randomNonce = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

export type EnclaveState = "checking" | "pass" | "fail" | "none" | "offline";

/** Runs the attestation checks that need no third party, once and then every five minutes. A 503 means there is no TEE to ask; no answer at all means the service is off. */
export function useEnclaveCheck(api: Api): EnclaveState {
  const [state, setState] = useState<EnclaveState>("checking");
  useEffect(() => {
    let live = true;
    const run = async () => {
      try {
        const nonce = randomNonce();
        const [ev, info] = await Promise.all([api.attestation(nonce), api.appInfo()]);
        const checks = await checkAttestation(nonce, ev, info);
        if (live) setState(checks.every((c) => c.status === "pass") ? "pass" : "fail");
      } catch (e) {
        if (live) setState(isOffline(e) ? "offline" : e instanceof ApiError && e.status === 503 ? "none" : "fail");
      }
    };
    void run();
    const id = setInterval(() => void run(), 5 * 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [api]);
  return state;
}

export interface Pill {
  id: string;
  label: string;
  tone: Tone;
  title: string;
  href?: string;
}

/** Pure: what each pill says, from the facts. Kept apart from the component so the wording is testable. */
export function statusPills(enclave: EnclaveState, status: ServiceStatus | null): Pill[] {
  const pills: Pill[] = [];
  pills.push(
    enclave === "pass"
      ? { id: "enclave", label: "Enclave verified", tone: "ok", title: "This browser just checked the service's attestation. Open Verify for the details, including Phala's signature check.", href: "#/verify" }
      : enclave === "checking"
        ? { id: "enclave", label: "Checking enclave", tone: "idle", title: "Asking the service for a fresh attestation.", href: "#/verify" }
        : enclave === "offline"
          ? { id: "enclave", label: "Offline", tone: "idle", title: "The engine runs on demand and is switched off right now. Open Verify for how to check it.", href: "#/verify" }
        : enclave === "none"
          ? { id: "enclave", label: "Not in an enclave", tone: "warn", title: "This service is not running inside a TEE, so there is nothing to attest.", href: "#/verify" }
          : { id: "enclave", label: "Enclave check failed", tone: "bad", title: "At least one attestation check failed or could not run. Open Verify to see which.", href: "#/verify" },
  );
  if (!status) return pills;
  pills.push(
    status.pricing === "ready"
      ? { id: "pricing", label: "Pricing live", tone: "ok", title: "The asset list and prices are loaded." }
      : { id: "pricing", label: "Pricing retrying", tone: "warn", title: "The market data service was unreachable at startup. Trades are blocked until it loads; Norr keeps retrying." },
  );
  pills.push(
    status.shield === "ok"
      ? { id: "shield", label: "Shield clear", tone: "ok", title: "The NEAR Intents incident feed reports no incidents." }
      : status.shield === "incidents"
        ? { id: "shield", label: "Shield incident", tone: "warn", title: "The incident feed lists an active incident. Trades in affected assets are blocked." }
        : status.shield === "not_configured"
          ? { id: "shield", label: "Incident feed: not enabled", tone: "idle", title: "NEAR Intents incident feed: optional integration, not enabled yet. When enabled, an active incident touching an asset blocks trades in it. Every other check runs." }
          : { id: "shield", label: "Shield unavailable", tone: "bad", title: "The incident feed is configured but cannot be read. Trades fail closed: all are blocked until it answers." },
  );
  pills.push(
    status.vaults.total === 0
      ? { id: "vaults", label: "No vaults", tone: "idle", title: "No vault is linked to this account." }
      : status.vaults.paused > 0
        ? { id: "vaults", label: status.vaults.paused === status.vaults.total ? "Paused" : `${status.vaults.paused} paused`, tone: "bad", title: "A paused vault refuses every agent request until you resume it." }
        : { id: "vaults", label: status.vaults.total === 1 ? "Vault active" : `${status.vaults.total} vaults active`, tone: "ok", title: "Agents can trade within your rules." },
  );
  return pills;
}

/** The always-visible health strip: can this service be trusted right now, and can the agent trade right now. */
export function StatusBar({ api, version }: { api: Api; version: number }) {
  const enclave = useEnclaveCheck(api);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      api.status().then(
        (s) => live && (setStatus(s), setFailed(false)),
        () => live && setFailed(true),
      );
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [api, version]);
  const pills = statusPills(enclave, status);
  return (
    <ul aria-label="Service status" className="mb-8 flex flex-wrap gap-x-5 gap-y-1.5 font-mono text-xs text-mute">
      {pills.map((p) => {
        const inner = (
          <>
            <span aria-hidden="true" className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${DOT[p.tone]}`} />
            {p.label}
          </>
        );
        return (
          <li key={p.id} className="whitespace-nowrap" title={p.title}>
            {p.href ? <a href={p.href} className="hover:text-fg">{inner}</a> : inner}
          </li>
        );
      })}
      {failed && enclave !== "offline" && (
        <li className="whitespace-nowrap" title="The status request failed. The other indicators may be out of date.">
          <span aria-hidden="true" className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${DOT.warn}`} />
          Status unavailable
        </li>
      )}
    </ul>
  );
}
