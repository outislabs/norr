export type Client = "any" | "claude-app" | "claude-code" | "claude-desktop" | "cursor" | "openai" | "rest" | "norr-agent";

export interface SnippetBlock {
  label: string;
  language: "bash" | "json" | "python" | "text";
  text: string;
}

export interface McpSnippet {
  client: Client;
  title: string;
  /** What the owner needs to know before pasting. */
  note: string;
  blocks: SnippetBlock[];
  /** Whether we have run this exact path end to end. Shown to the owner as is. */
  status: "tested" | "not yet tested";
  /** What "tested" or "not yet tested" means for this path, in one sentence. */
  statusNote: string;
  link?: { href: string; label: string };
}

const PLACEHOLDER = "PASTE_YOUR_AGENT_TOKEN";
/** The bridge's built-in endpoint; other endpoints are passed as NORR_MCP_URL. */
const BRIDGE_DEFAULT = "https://mcp.norr.finance/mcp";
const DOCS = "https://norr.finance/docs";
/** @norrfi/mcp is on npm (0.1.0, 2026-11-03). Set to false to fall back to the generic mcp-remote bridge. */
export const BRIDGE_PUBLISHED = true;

/**
 * Copy-ready connections for every way an agent can reach Norr: MCP over streamable HTTP (any client), the npx stdio
 * bridge, named clients, and the plain REST API. The token is a placeholder until one is created.
 */
export function mcpSnippets(mcpUrl: string, token: string | null, apiUrl = "http://localhost:8787", bridgePublished = BRIDGE_PUBLISHED): McpSnippet[] {
  const t = token ?? PLACEHOLDER;
  // A local command that bridges stdio to the hosted endpoint: Norr's own package once published, mcp-remote until then.
  const stdio = bridgePublished
    ? { mcpServers: { norr: { command: "npx", args: ["-y", "@norrfi/mcp"], env: { NORR_AGENT_TOKEN: t, ...(mcpUrl === BRIDGE_DEFAULT ? {} : { NORR_MCP_URL: mcpUrl }) } } } }
    : { mcpServers: { norr: { command: "npx", args: ["-y", "mcp-remote", mcpUrl, "--header", "Authorization:${NORR_AUTH}"], env: { NORR_AUTH: `Bearer ${t}` } } } };
  const bridgeEnvShell = Object.entries((stdio.mcpServers.norr as { env: Record<string, string> }).env).map(([k, v]) => `--env ${k}=${v}`).join(" ");
  return [
    {
      client: "any",
      title: "Any MCP client",
      note: "Norr is a standard MCP server over streamable HTTP. Point any client at the endpoint and send the token in the Authorization header. Clients that only start local commands can use the npx bridge instead.",
      blocks: [
        { label: "Remote (streamable HTTP)", language: "text", text: `URL:     ${mcpUrl}\nHeader:  Authorization: Bearer ${t}` },
        { label: "Local command (stdio bridge, needs Node)", language: "json", text: JSON.stringify(stdio, null, 2) },
      ],
      status: "tested",
      statusNote: bridgePublished
        ? "Tested on 2026-11-03 against the hosted endpoint: over HTTP (MCP SDK client, Claude Code) and through npx @norrfi/mcp from npm (MCP SDK client, Claude Code)."
        : "The endpoint is tested with the MCP TypeScript SDK client over HTTP; the mcp-remote bridge is a third-party package we have not run against Norr.",
      link: { href: `${DOCS}/connect-agent/`, label: "Connect your agent (docs)" },
    },
    {
      client: "claude-app",
      title: "Claude app",
      note: "No token to paste. In Claude (claude.ai, desktop or mobile), open Settings, Connectors, Add custom connector, and enter this URL. Claude sends you to Norr to sign in with your wallet and pick the vault it may use. Disconnect it any time under Agents with access.",
      blocks: [{ label: "Connector URL", language: "text", text: mcpUrl }],
      status: "not yet tested",
      statusNote: "OAuth sign-in (MCP authorization) is tested end to end against Norr's own test client; not yet run from the Claude app itself.",
    },
    {
      client: "claude-code",
      title: "Claude Code",
      note: "Adds Norr as a remote MCP server. The token travels in a header on every request.",
      blocks: [
        { label: "Remote", language: "bash", text: `claude mcp add --transport http norr ${mcpUrl} --header "Authorization: Bearer ${t}"` },
        ...(bridgePublished ? [{ label: "Or through the stdio bridge", language: "bash" as const, text: `claude mcp add norr ${bridgeEnvShell} -- npx -y @norrfi/mcp` }] : []),
      ],
      status: "tested",
      statusNote: "Both run on 2026-11-03 with Claude Code 2.1.80 against mcp.norr.finance: tools listed, rules, portfolio and P&L read, an over-limit trade refused as Norr gave it.",
    },
    {
      client: "claude-desktop",
      title: "Claude Desktop",
      note: "Merge this into mcpServers in claude_desktop_config.json (Settings, Developer, Edit Config), then quit and reopen Claude. Needs Node for npx.",
      blocks: [{ label: "claude_desktop_config.json", language: "json", text: JSON.stringify(stdio, null, 2) }],
      status: "not yet tested",
      statusNote: "Not yet run inside Claude Desktop by us. The same npx @norrfi/mcp command is tested against the hosted endpoint with Claude Code and the MCP SDK client.",
    },
    {
      client: "cursor",
      title: "Cursor",
      note: "Add this to ~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project). Cursor connects to remote servers by URL and sends the headers you set; it can also read the token from an environment variable with ${env:NAME}.",
      blocks: [{ label: "mcp.json", language: "json", text: JSON.stringify({ mcpServers: { norr: { url: mcpUrl, headers: { Authorization: `Bearer ${t}` } } } }, null, 2) }],
      status: "not yet tested",
      statusNote: "Format from Cursor's MCP documentation; not yet run against Norr by us.",
    },
    {
      client: "openai",
      title: "ChatGPT / OpenAI",
      note: "With the OpenAI Agents SDK, your own process connects to Norr and sends the token as a header, so OpenAI never sees it. The Responses API's hosted MCP tool connects from OpenAI's side and takes the token in its authorization field. We have not confirmed that ChatGPT's in-app connectors can send a static token, so use one of these.",
      blocks: [
        {
          label: "OpenAI Agents SDK (Python)",
          language: "python",
          text: `from agents import Agent, Runner\nfrom agents.mcp import MCPServerStreamableHttp\n\nasync with MCPServerStreamableHttp(\n    name="norr",\n    params={"url": "${mcpUrl}", "headers": {"Authorization": "Bearer ${t}"}},\n) as norr:\n    agent = Agent(name="Trader", instructions="Trade only through Norr's tools.", mcp_servers=[norr])\n    result = await Runner.run(agent, "What are my Norr rules?")\n    print(result.final_output)`,
        },
        {
          label: "Responses API (hosted MCP tool)",
          language: "python",
          text: `from openai import OpenAI\n\nresp = OpenAI().responses.create(\n    model="<model>",\n    tools=[{\n        "type": "mcp",\n        "server_label": "norr",\n        "server_url": "${mcpUrl}",\n        "authorization": "${t}",\n        "require_approval": "always",\n    }],\n    input="What are my Norr rules?",\n)`,
        },
      ],
      status: "not yet tested",
      statusNote: "Formats from OpenAI's documentation; neither has been run against Norr by us. The hosted tool needs a public endpoint, and the documentation does not say whether it adds the Bearer prefix itself.",
    },
    {
      client: "rest",
      title: "REST API",
      note: "Every MCP tool is also a plain HTTPS call, for agents and scripts that do not use MCP. Same token, same rules.",
      blocks: [
        { label: "Price a trade (no funds move)", language: "bash", text: `curl -X POST ${apiUrl}/v1/quote \\\n  -H "Authorization: Bearer ${t}" -H "content-type: application/json" \\\n  -d '{"side":"buy","asset":"NVDA","amountUsd":40}'` },
        { label: "Request a trade", language: "bash", text: `curl -X POST ${apiUrl}/v1/trade \\\n  -H "Authorization: Bearer ${t}" -H "content-type: application/json" \\\n  -d '{"side":"buy","asset":"NVDA","amountUsd":40,"reason":"why, for the owner only"}'` },
      ],
      status: "tested",
      statusNote: "The API is covered by the repository's tests and pnpm judge in mock mode, and its responses are checked against the OpenAPI spec.",
      link: { href: `${DOCS}/api/`, label: "API reference" },
    },
    {
      client: "norr-agent",
      title: "Norr agent (private model on NEAR AI Cloud)",
      note: "The reference agent in this repository. It checks the attestation of every model response it uses. Needs a NEAR AI Cloud key in NEAR_AI_API_KEY.",
      blocks: [{ label: "From the repository", language: "bash", text: `NORR_AGENT_TOKEN=${t} pnpm --filter @norr/agent exec tsx src/cli.ts \\\n  --mcp ${mcpUrl} --model z-ai/glm-5.3-flash "Check my portfolio and rules, do not trade."` }],
      status: "tested",
      statusNote: "Run end to end against Norr with a model on NEAR AI Cloud.",
    },
  ];
}
