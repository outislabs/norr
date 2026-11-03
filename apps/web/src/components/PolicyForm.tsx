import { EQUITY_DISCLAIMER, presetPolicy, type PresetName } from "@norr/core";
import { Policy } from "@norr/shared";
import { useState } from "react";

interface Form {
  maxTradeUsd: string;
  dailySpendCapUsd: string;
  dailyLossCapUsd: string;
  maxEquityPct: string;
  cooldownSec: string;
  allowedEquities: string;
  cryptoMode: "any_safe" | "list";
  allowedCrypto: string;
  allowMediumRisk: boolean;
  privacy: "public" | "prefer" | "require";
  nonUsConfirmed: boolean;
}

export function toForm(p: Policy): Form {
  return {
    maxTradeUsd: String(p.maxTradeUsd),
    dailySpendCapUsd: String(p.dailySpendCapUsd),
    dailyLossCapUsd: String(p.dailyLossCapUsd),
    maxEquityPct: String(p.maxEquityPct),
    cooldownSec: String(p.cooldownSec),
    allowedEquities: p.allowedEquities.join(", "),
    cryptoMode: p.allowedCrypto === "any_safe" ? "any_safe" : "list",
    allowedCrypto: p.allowedCrypto === "any_safe" ? "" : p.allowedCrypto.join(", "),
    allowMediumRisk: p.allowMediumRisk,
    privacy: p.privacy,
    nonUsConfirmed: p.nonUsConfirmed,
  };
}

const list = (s: string): string[] => s.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
const num = (s: string): number => (s.trim() === "" ? Number.NaN : Number(s));

/** Turn the form back into a policy, or say what is wrong in plain words. The service validates again. */
export function fromForm(f: Form, base: Policy): { policy: Policy } | { issues: string[] } {
  const candidate = {
    vaultId: base.vaultId,
    paused: base.paused,
    maxTradeUsd: num(f.maxTradeUsd),
    dailySpendCapUsd: num(f.dailySpendCapUsd),
    dailyLossCapUsd: num(f.dailyLossCapUsd),
    maxEquityPct: num(f.maxEquityPct),
    cooldownSec: num(f.cooldownSec),
    allowedEquities: list(f.allowedEquities),
    allowedCrypto: f.cryptoMode === "any_safe" ? ("any_safe" as const) : list(f.allowedCrypto),
    allowMediumRisk: f.allowMediumRisk,
    privacy: f.privacy,
    nonUsConfirmed: f.nonUsConfirmed,
  };
  const r = Policy.safeParse(candidate);
  if (r.success) return { policy: r.data };
  const names: Record<string, string> = { maxTradeUsd: "Largest single trade", dailySpendCapUsd: "Daily spending cap", dailyLossCapUsd: "Daily loss cap", maxEquityPct: "Share in stocks", cooldownSec: "Cooldown" };
  return { issues: r.error.issues.map((i) => `${names[String(i.path[0])] ?? String(i.path[0])}: ${i.message}`) };
}

const PRIVACY: { value: Form["privacy"]; title: string; text: string }[] = [
  { value: "prefer", title: "Confidential when possible", text: "Trade in the confidential layer whenever the vault holds the funds there; use the public layer only if it cannot." },
  { value: "require", title: "Confidential only", text: "Refuse any trade that cannot run confidentially. Never falls back to public." },
  { value: "public", title: "Public only", text: "Trade only in the public layer, where amounts and pairs are visible on-chain." },
];

export function PolicyForm({ policy, onSave }: { policy: Policy; onSave: (p: Policy) => Promise<void> }) {
  const [form, setForm] = useState<Form>(() => toForm(policy));
  const [issues, setIssues] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  };
  const applyPreset = (name: PresetName) => {
    const p = presetPolicy(name, policy.vaultId);
    // A preset sets limits only. Confirming non-US status and the privacy mode stay as the owner chose.
    setForm((f) => ({ ...toForm({ ...p, nonUsConfirmed: f.nonUsConfirmed, privacy: f.privacy }) }));
    setSaved(false);
  };
  const numberField = (k: keyof Form, label: string, hint?: string) => (
    <div>
      <label className="label" htmlFor={`f-${k}`}>
        {label}
      </label>
      <input id={`f-${k}`} className="field" inputMode="decimal" value={String(form[k])} onChange={(e) => set(k, e.target.value as never)} />
      {hint && <p className="mt-1 text-sm text-mute">{hint}</p>}
    </div>
  );

  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = fromForm(form, policy);
        if ("issues" in r) return setIssues(r.issues);
        setIssues([]);
        setBusy(true);
        try {
          await onSave(r.policy);
          setSaved(true);
        } catch (err) {
          setIssues([err instanceof Error ? err.message : "Could not save."]);
        } finally {
          setBusy(false);
        }
      }}
    >
      <section aria-labelledby="presets">
        <h3 id="presets" className="font-display text-xl">
          Start from a style
        </h3>
        <p className="mb-3 text-sm text-mute">Fills in the limits below. You can change any of them.</p>
        <div className="flex flex-wrap gap-2">
          {(["cautious", "balanced", "degen"] as const).map((n) => (
            <button key={n} type="button" className="btn btn-quiet" onClick={() => applyPreset(n)}>
              {n[0]!.toUpperCase() + n.slice(1)}
            </button>
          ))}
        </div>
      </section>

      <section className="grid gap-5 sm:grid-cols-2" aria-label="Limits">
        {numberField("maxTradeUsd", "Largest single trade (USD)")}
        {numberField("dailySpendCapUsd", "Daily spending cap (USD)", "Total buys per day, so a big trade cannot be split into small ones.")}
        {numberField("dailyLossCapUsd", "Daily loss cap (USD)", "Buying stops after this much realized loss in a day. Selling always works.")}
        {numberField("maxEquityPct", "Most the vault may hold in stocks (%)")}
        {numberField("cooldownSec", "Wait between trades (seconds)")}
      </section>

      <section aria-labelledby="privacy">
        <h3 id="privacy" className="font-display text-xl">
          Privacy
        </h3>
        <div className="mt-3 flex flex-col gap-3">
          {PRIVACY.map((o) => (
            <label key={o.value} className="flex cursor-pointer gap-3">
              <input type="radio" name="privacy" className="mt-1.5 accent-white" checked={form.privacy === o.value} onChange={() => set("privacy", o.value)} />
              <span>
                <span className="block text-fg">{o.title}</span>
                <span className="block text-sm text-mute">{o.text}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section aria-labelledby="assets" className="flex flex-col gap-5">
        <h3 id="assets" className="font-display text-xl">
          What the agent may trade
        </h3>
        <div>
          <label className="label" htmlFor="f-eq">
            Stocks and ETFs (tickers)
          </label>
          <input id="f-eq" className="field" value={form.allowedEquities} onChange={(e) => set("allowedEquities", e.target.value)} placeholder="NVDA, TSLA" />
        </div>
        <fieldset>
          <legend className="label">Crypto</legend>
          <label className="mr-6 inline-flex items-center gap-2">
            <input type="radio" name="crypto" className="accent-white" checked={form.cryptoMode === "any_safe"} onChange={() => set("cryptoMode", "any_safe")} /> Anything that passes the risk check
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" name="crypto" className="accent-white" checked={form.cryptoMode === "list"} onChange={() => set("cryptoMode", "list")} /> Only these
          </label>
          {form.cryptoMode === "list" && <input aria-label="Allowed crypto symbols" className="field mt-3" value={form.allowedCrypto} onChange={(e) => set("allowedCrypto", e.target.value)} placeholder="BTC, ETH, SOL, USDC" />}
        </fieldset>
        <label className="flex cursor-pointer gap-3">
          <input type="checkbox" className="mt-1.5 accent-white" checked={form.allowMediumRisk} onChange={(e) => set("allowMediumRisk", e.target.checked)} />
          <span>
            <span className="block text-fg">Allow medium-risk tokens</span>
            <span className="block text-sm text-mute">High-risk tokens are always refused.</span>
          </span>
        </label>
      </section>

      <section aria-labelledby="eligibility" className="border-l border-line-strong pl-4">
        <h3 id="eligibility" className="font-display text-xl">
          Tokenized stocks
        </h3>
        <p className="my-2 text-sm text-mute">{EQUITY_DISCLAIMER}</p>
        <label className="flex cursor-pointer gap-3">
          <input type="checkbox" className="mt-1.5 accent-white" checked={form.nonUsConfirmed} onChange={(e) => set("nonUsConfirmed", e.target.checked)} />
          <span>I confirm that I am not a US person. Until I do, the agent cannot trade stocks.</span>
        </label>
      </section>

      {issues.length > 0 && (
        <ul role="alert" className="list-disc pl-5 text-alert">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-4">
        <button type="submit" className="btn btn-solid" disabled={busy}>
          {busy ? "Saving…" : "Save rules"}
        </button>
        {saved && (
          <span role="status" className="text-ok">
            Saved. The agent follows these rules from its next request.
          </span>
        )}
      </div>
    </form>
  );
}
