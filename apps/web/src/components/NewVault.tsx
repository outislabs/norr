import { useState } from "react";
import type { Api, BetaInfo } from "../lib/api";
import { setupHref } from "../lib/route";

/**
 * The empty state for a signed-in account without a vault, and the first step of creating one: the beta's limits, the
 * terms and risk disclosure, and (optionally) non-US status for stocks.
 */
export function NewVault({ api, account, beta, onCreated, navigate = (h) => (window.location.hash = h) }: { api: Api; account: string; beta: BetaInfo; onCreated?: () => void; navigate?: (hash: string) => void }) {
  const [terms, setTerms] = useState(false);
  const [nonUs, setNonUs] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invited, setInvited] = useState(false);

  // Closed to the public, the service still lets invited accounts in; it decides, the page only offers.
  if (!beta.signupsOpen && !invited) {
    return (
      <div className="border-l border-line-strong pl-4">
        <p className="font-display text-xl">New vaults are paused for now</p>
        <p className="mt-1 text-mute">The public beta is not taking new vaults at the moment. Vaults that already exist keep working. Check back soon.</p>
        <button type="button" className="btn btn-quiet mt-3" onClick={() => setInvited(true)}>
          I was invited
        </button>
      </div>
    );
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const v = await api.createVault({ ...(name.trim() ? { name: name.trim() } : {}), acceptTerms: beta.termsVersion ?? "", nonUsConfirmed: nonUs });
      onCreated?.();
      navigate(setupHref(v.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The vault was not created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="new-vault" className="flex flex-col gap-5">
      <div>
        <h2 id="new-vault" className="font-display text-2xl">Create your vault</h2>
        <p className="mt-2 text-mute">
          A vault is a custody wallet your agent trades from, inside rules you set. Your NEAR account (<span className="mono">{account}</span>) controls it: you approve what it does, and money can only be sent back to you.
        </p>
      </div>
      <ol className="flex flex-col border-t border-line">
        {[
          ["Create", "Norr opens a custody wallet for you at OutLayer, sealed in Norr's enclave."],
          ["Sign its policy", "Your wallet signs one transaction (about 0.03 NEAR of storage) that makes you the policy's controller."],
          ["Fund and connect", "Add up to $" + (beta.depositCapUsd ?? 100) + " and give your agent a token."],
        ].map(([t, d], i) => (
          <li key={t} className="flex gap-3 border-b border-line py-3">
            <span className="mono text-dim">{i + 1}</span>
            <span>
              <span className="block text-fg">{t}</span>
              <span className="block text-sm text-mute">{d}</span>
            </span>
          </li>
        ))}
      </ol>
      <div>
        <label className="label" htmlFor="vault-name">Name it (optional; you can rename it later)</label>
        <input id="vault-name" className="field max-w-sm" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="My agent's vault" autoComplete="off" />
      </div>
      <div className="flex flex-col gap-3">
        <p className="eyebrow">Public beta</p>
        <ul className="flex flex-col gap-1 text-sm text-mute">
          <li>Up to ${beta.depositCapUsd ?? 100} per vault; {beta.maxVaultsPerOwner ?? 1} vault per account.</li>
          <li>Real money on mainnet. Trades can lose value; the custody provider and Norr are new software.</li>
          <li>Tokenized stocks are not available to US persons.</li>
        </ul>
        <label className="flex cursor-pointer gap-3">
          <input type="checkbox" className="mt-1.5 accent-white" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
          <span>
            I have read and accept the{" "}
            <a className="underline decoration-line-strong underline-offset-4" href={beta.termsUrl ?? "https://norr.finance/docs/terms/"} target="_blank" rel="noreferrer">
              beta terms and risk disclosure
            </a>{" "}
            (version {beta.termsVersion}).
          </span>
        </label>
        <label className="flex cursor-pointer gap-3">
          <input type="checkbox" className="mt-1.5 accent-white" checked={nonUs} onChange={(e) => setNonUs(e.target.checked)} />
          <span>
            <span className="block">I am not a US person.</span>
            <span className="block text-sm text-mute">Optional. Without it, your agent can trade crypto but not tokenized stocks. You can confirm it later in Rules.</span>
          </span>
        </label>
      </div>
      {error && <p role="alert" className="border-l border-line-strong pl-3 text-sm text-fg">{error}</p>}
      <div>
        <button type="button" className="btn btn-solid" disabled={!terms || busy} onClick={() => void create()}>
          {busy ? "Creating…" : "Create vault"}
        </button>
      </div>
    </section>
  );
}
