export type Client = "claude-code" | "claude-desktop" | "norr-agent";

export interface McpSnippet {
  client: Client;
  title: string;
  /** What the owner needs to know before pasting. */
  note: string;
  language: "bash" | "json";
  /** Tested against Norr's own MCP tests, a live client, or neither. Shown to the user. */
  status: "tested" | "untested";
  text: string;
}

const PLACEHOLDER = "PASTE_YOUR_AGENT_TOKEN";

/** Copy-ready connection snippets for the remote (streamable HTTP) MCP endpoint. The token is a placeholder until one is created. */
export function mcpSnippets(mcpUrl: string, token: string | null): McpSnippet[] {
  const t = token ?? PLACEHOLDER;
  return [
    {
      client: "claude-code",
      title: "Claude Code",
      note: "Adds Norr as a remote MCP server. The token travels in a header on every request.",
      language: "bash",
      status: "untested",
      text: `claude mcp add --transport http norr ${mcpUrl} --header "Authorization: Bearer ${t}"`,
    },
    {
      client: "claude-desktop",
      title: "Claude Desktop",
      note: "Claude Desktop reaches a remote server with the mcp-remote bridge (needs Node). Merge this into mcpServers in claude_desktop_config.json, then quit and reopen Claude.",
      language: "json",
      status: "untested",
      text: JSON.stringify({ mcpServers: { norr: { command: "npx", args: ["-y", "mcp-remote", mcpUrl, "--header", "Authorization:${NORR_AUTH}"], env: { NORR_AUTH: `Bearer ${t}` } } } }, null, 2),
    },
    {
      client: "norr-agent",
      title: "Norr agent (private model on NEAR AI Cloud)",
      note: "The reference agent in this repository. It checks the attestation of every model response it uses. Needs a NEAR AI Cloud key in NEAR_AI_API_KEY.",
      language: "bash",
      status: "tested",
      text: `NORR_AGENT_TOKEN=${t} pnpm --filter @norr/agent exec tsx src/cli.ts \\\n  --mcp ${mcpUrl} --model z-ai/glm-5.3-flash "Check my portfolio and rules, do not trade."`,
    },
  ];
}
