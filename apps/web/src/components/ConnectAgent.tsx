import { useState } from "react";
import type { Api } from "../lib/api";
import { setFlag } from "../lib/flags";
import { mcpSnippets, type Client } from "../lib/mcp";
import { CopyBlock } from "./CopyBlock";

const TOOLS = ["list_assets", "check_asset", "get_market_data", "get_quote", "trade", "get_portfolio", "get_pnl", "get_policy", "get_activity"];

/** Create (or revoke) the token the agent uses, and hand the owner a ready-to-paste connection for whatever agent they run. */
export function ConnectAgent({ api, vaultId, mcpUrl, apiUrl, onIssued }: { api: Api; vaultId: string; mcpUrl: string; apiUrl?: string; onIssued?: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [client, setClient] = useState<Client>("any");
  const snippets = mcpSnippets(mcpUrl, token, apiUrl);
  const shown = snippets.find((s) => s.client === client) ?? snippets[0]!;
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="font-display text-xl">What your agent gets</h2>
        <p className="mt-1 text-sm text-mute">One token, for this vault only. With it the agent can read the vault, get quotes and trade within your rules. It cannot withdraw, change the rules, or choose where funds go.</p>
      </div>

      <div>
        <h2 className="font-display text-xl">1. Create a token</h2>
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            className="btn btn-solid"
            onClick={async () => {
              setError(null);
              setRevoked(false);
              try {
                setToken((await api.issueToken(vaultId)).token);
                setFlag(`token-${vaultId}`);
                onIssued?.();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not create a token.");
              }
            }}
          >
            Create an agent token
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={async () => {
              setError(null);
              try {
                await api.revokeTokens(vaultId);
                setToken(null);
                setRevoked(true);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not revoke.");
              }
            }}
          >
            Revoke all tokens
          </button>
        </div>
        {token && (
          <div className="mt-4" data-testid="agent-token">
            <p role="status" className="mb-2 text-sm text-fg">Your agent token. It is shown once: copy it before you leave this page. The snippets below already contain it.</p>
            <CopyBlock text={token} label="Agent token" />
          </div>
        )}
        {revoked && <p role="status" className="mt-3 text-sm text-fg">Every token for this vault has been revoked. Agents holding one are refused from now on.</p>}
        {error && <p role="alert" className="mt-3 text-sm text-fg">{error}</p>}
        <p className="mt-3 text-sm text-mute">To rotate a token, revoke all first, then create a new one: revoking removes every token on the vault, including one you just made. Restarting the service also revokes them, so create a fresh one after a restart.</p>
      </div>

      <div>
        <h2 className="font-display text-xl">2. Connect your agent</h2>
        <p className="mt-1 text-sm text-mute">Works with any MCP-compatible agent, or any code that can call the REST API.</p>
        <div role="tablist" aria-label="Agent client" className="-mx-4 mt-4 flex gap-x-5 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:flex-wrap sm:px-0">
          {snippets.map((s) => (
            <button key={s.client} role="tab" type="button" aria-selected={s.client === client} onClick={() => setClient(s.client)} className={`shrink-0 whitespace-nowrap pb-2 text-[15px] ${s.client === client ? "border-b border-fg text-fg" : "text-mute hover:text-fg"}`}>
              {s.title.split(" (")[0]}
            </button>
          ))}
        </div>
        <div role="tabpanel" aria-label={shown.title} className="mt-4 flex flex-col gap-4">
          <p className="flex items-center gap-2 text-xs">
            <span className={`rounded-full border px-2 py-0.5 font-mono uppercase tracking-[0.08em] ${shown.status === "tested" ? "border-fg text-fg" : "border-line-strong text-mute"}`}>{shown.status}</span>
            <span className="text-dim">{shown.statusNote}</span>
          </p>
          <p className="text-sm text-mute">{shown.note}</p>
          {shown.blocks.map((b) => (
            <div key={b.label}>
              <p className="eyebrow mb-2">{b.label}</p>
              <CopyBlock text={b.text} label={`${shown.title}: ${b.label}`} />
            </div>
          ))}
          {shown.link && (
            <a href={shown.link.href} target="_blank" rel="noopener noreferrer" className="text-sm text-fg hover:text-mute">
              {shown.link.label} ↗
            </a>
          )}
        </div>
        <dl className="mt-6 grid grid-cols-[6rem_minmax(0,1fr)] gap-y-1 text-sm">
          <dt className="text-mute">MCP endpoint</dt>
          <dd className="mono break-all">{mcpUrl}</dd>
          <dt className="text-mute">Tools</dt>
          <dd>{TOOLS.join(", ")}</dd>
        </dl>
      </div>
    </div>
  );
}
