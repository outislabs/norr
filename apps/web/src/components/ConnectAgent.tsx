import { useState } from "react";
import type { Api } from "../lib/api";
import { setFlag } from "../lib/flags";
import { mcpSnippets, type Client } from "../lib/mcp";
import { CopyBlock } from "./CopyBlock";

/** Create (or revoke) the token the agent uses, and hand the owner a ready-to-paste connection for their client. */
export function ConnectAgent({ api, vaultId, mcpUrl, onIssued }: { api: Api; vaultId: string; mcpUrl: string; onIssued?: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [client, setClient] = useState<Client>("claude-code");
  const snippets = mcpSnippets(mcpUrl, token);
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
        {token && <p role="status" className="mt-3 text-sm text-accent">Token created. The snippets below now contain it. It is shown once: copy before you leave this page.</p>}
        {revoked && <p role="status" className="mt-3 text-sm text-ok">Every token for this vault has been revoked. Agents holding one are refused from now on.</p>}
        {error && <p role="alert" className="mt-3 text-sm text-alert">{error}</p>}
        <p className="mt-3 text-sm text-mute">To rotate a token, revoke all first, then create a new one: revoking removes every token on the vault, including one you just made. Restarting the service also revokes them, so create a fresh one after a restart.</p>
      </div>

      <div>
        <h2 className="font-display text-xl">2. Paste it into your agent</h2>
        <div role="tablist" aria-label="Agent client" className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-b border-line">
          {snippets.map((s) => (
            <button key={s.client} role="tab" type="button" aria-selected={s.client === client} onClick={() => setClient(s.client)} className={`pb-2 text-[15px] ${s.client === client ? "border-b border-accent text-fg" : "text-mute hover:text-fg"}`}>
              {s.title.split(" (")[0]}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="mt-4 flex flex-col gap-3">
          <p className="text-sm text-mute">{shown.note}</p>
          <CopyBlock text={shown.text} label={`${shown.title} connection`} />
          <p className="text-sm text-mute">
            {shown.status === "tested" ? "This path has been run end to end against Norr." : "Not yet run against this client by us: if it does not connect, the endpoint below can be checked with the MCP inspector."}
          </p>
        </div>
        <dl className="mt-5 grid grid-cols-[6rem_1fr] gap-y-1 text-sm">
          <dt className="text-mute">Endpoint</dt>
          <dd className="mono break-all">{mcpUrl}</dd>
          <dt className="text-mute">Tools</dt>
          <dd>list_assets, check_asset, get_quote, trade, get_portfolio, get_policy, get_activity</dd>
        </dl>
      </div>
    </div>
  );
}
