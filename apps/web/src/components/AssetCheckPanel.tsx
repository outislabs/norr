import { useState } from "react";
import type { Api, AssetCheck } from "../lib/api";

const STATUS: Record<string, string> = {
  ok: "Checked by GoPlus",
  not_covered: "Not checked by GoPlus",
  no_data: "No GoPlus data",
  unreachable: "GoPlus unreachable",
};

/**
 * The owner's view of what the agent sees from check_asset: Scam Shield's verdict for a token, with the market-data
 * reasons and the GoPlus contract findings, or the eligibility notice for a stock.
 */
export function AssetCheckPanel({ api, vaultId }: { api: Api; vaultId: string }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AssetCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.checkAsset(vaultId, q));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : "Could not check that asset.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="check-token" className="flex flex-col gap-4">
      <div>
        <h3 id="check-token" className="font-display text-xl">Check a token</h3>
        <p className="mt-1 text-sm text-mute">What Scam Shield tells your agent before it trades: market data (liquidity, market cap, age) and contract checks from GoPlus Security. Name a token by symbol, or exactly by chain and contract address (for example <span className="mono">base:0x8335…</span>).</p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input className="field" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="SOL, NVDA, or chain:contract" aria-label="Token to check" autoCapitalize="none" spellCheck={false} />
        <button type="submit" className="btn shrink-0" disabled={busy || !query.trim()}>
          {busy ? "Checking…" : "Check"}
        </button>
      </form>
      {error && <p role="alert" className="text-sm text-fg">{error}</p>}
      {result && !result.found && <p className="text-sm text-mute">{result.message}</p>}
      {result && !result.found && result.safety?.risk && (
        <div className="border-t border-line pt-3" data-testid="safety-report">
          <p className="eyebrow mb-1">Safety report for {result.contract?.chain}:{result.contract?.address} (not tradable)</p>
          <p className="font-mono text-xs uppercase tracking-[0.08em]">
            {result.safety.risk.level} risk · {result.safety.risk.score}/100
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-mute">
            {result.safety.risk.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {result?.found && result.ambiguous && <p role="status" className="border-l border-line-strong pl-3 text-sm text-fg">{result.message}</p>}
      {result?.found && (
        <div className="flex flex-col gap-4" data-testid="asset-check">
          {result.class === "equity" && (
            <p className="text-sm text-mute">
              Tokenized stock ({result.ticker}). {result.eligible ? "This vault may trade it." : "Blocked until you confirm non-US status."} {result.notice}
            </p>
          )}
          {result.versions?.map((v) => (
            <div key={`${v.symbol}-${v.chain}`} className="border-t border-line pt-3">
              <p className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  {v.symbol} <span className="text-sm text-mute">on {v.chain}{v.issuer ? `, ${v.issuer}` : ""}</span>
                  {v.contract && <span className="mono block text-xs text-dim">{v.chain}:{v.contract}</span>}
                </span>
                {v.risk && (
                  <span className="font-mono text-xs uppercase tracking-[0.08em]">
                    {v.risk.level} risk · {v.risk.score}/100
                  </span>
                )}
              </p>
              {v.shieldBlocked && <p className="mt-1 text-sm text-fg">{v.shieldBlocked}</p>}
              {v.risk && (
                <ul className="mt-2 flex flex-col gap-1 text-sm text-mute">
                  {v.risk.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              {v.risk?.contract && (
                <div className="mt-3">
                  <p className="eyebrow mb-1">{STATUS[v.risk.contract.status] ?? v.risk.contract.status}</p>
                  <ul className="flex flex-col gap-1 text-sm">
                    {v.risk.contract.findings.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
