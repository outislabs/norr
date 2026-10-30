import { useState } from "react";
import type { Api } from "../lib/api";

const API_URL = (import.meta.env?.VITE_NORR_API_URL as string | undefined) ?? "http://localhost:8787";

/** Create (or revoke) the token the agent uses. The token is shown once; only its hash is kept. */
export function AgentAccess({ api, vaultId }: { api: Api; vaultId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const config = token
    ? JSON.stringify({ mcpServers: { norr: { command: "/ABSOLUTE/PATH/TO/node", args: ["/ABSOLUTE/PATH/TO/norr/node_modules/tsx/dist/cli.mjs", "/ABSOLUTE/PATH/TO/norr/apps/mcp/src/stdio.ts"], env: { NORR_API_URL: API_URL, NORR_AGENT_TOKEN: token } } } }, null, 2)
    : "";
  return (
    <div>
      <p className="text-sm text-mist">The agent holds only this token. It can trade within your rules and read this vault. It cannot move money out, change rules, or choose where funds go.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          className="btn"
          onClick={async () => {
            setError(null);
            setRevoked(false);
            try {
              setToken((await api.issueToken(vaultId)).token);
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
      {revoked && <p role="status" className="mt-3 text-verdigris">Every token for this vault has been revoked.</p>}
      {error && <p role="alert" className="mt-3 text-rust">{error}</p>}
      {token && (
        <div className="mt-4">
          <p className="text-sm text-brass">Copy this now. It is shown once.</p>
          <pre className="mono mt-2 overflow-x-auto whitespace-pre border border-line bg-vault p-3 text-sm">{config}</pre>
          <p className="mt-2 text-sm text-mist">Paste it into your agent's MCP settings (for Claude Desktop, see docs/MCP.md) and replace the /ABSOLUTE/PATH/TO placeholders.</p>
        </div>
      )}
    </div>
  );
}
