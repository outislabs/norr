# Connect an agent to Norr (MCP)

Norr exposes seven tools over MCP: `list_assets`, `check_asset`, `get_quote`, `trade`, `get_portfolio`, `get_policy`, `get_activity`. The agent holds only a Norr **agent token**, scoped to one vault. No tool can withdraw, change rules or choose a destination.

First start the Norr service. For a no-funds try-out: `pnpm dev:mock`, which prints an agent token (default API on `http://localhost:8787`).

## Claude Desktop (stdio)
Edit `claude_desktop_config.json` (Settings, Developer, Edit Config), using absolute paths:
```json
{
  "mcpServers": {
    "norr": {
      "command": "/ABSOLUTE/PATH/TO/norr/node_modules/.bin/tsx",
      "args": ["/ABSOLUTE/PATH/TO/norr/apps/mcp/src/stdio.ts"],
      "env": { "NORR_API_URL": "http://localhost:8787", "NORR_AGENT_TOKEN": "norr_agent_..." }
    }
  }
}
```
Restart Claude Desktop. Then try: "Buy $40 of NVDA", "Put $150 into TSLA", "Ape $5 into RUGPULL", "Swap $5 of USDC to SOL".

## Claude Code (stdio)
```
claude mcp add norr --env NORR_API_URL=http://localhost:8787 --env NORR_AGENT_TOKEN=norr_agent_... -- /ABSOLUTE/PATH/TO/norr/node_modules/.bin/tsx /ABSOLUTE/PATH/TO/norr/apps/mcp/src/stdio.ts
```

## Remote agents (streamable HTTP)
```
NORR_API_URL=http://localhost:8787 pnpm --filter @norr/mcp http      # serves http://127.0.0.1:8788/mcp
```
Clients send their own token as `Authorization: Bearer <agent token>`; the endpoint forwards it to the Norr service for that request only and stores nothing. It binds to localhost and rejects other `Host` headers (set `MCP_HOST` and `MCP_ALLOWED_HOSTS` when you deploy it behind a real hostname, and put TLS in front). With Claude Code: `claude mcp add --transport http norr http://127.0.0.1:8788/mcp --header "Authorization: Bearer norr_agent_..."` (check `claude mcp add --help` for your version).

## What the tests cover
`apps/mcp` tests exercise the tools through the MCP SDK client in-process, a real spawned stdio process, and the real HTTP endpoint, all against the mock service. They have not been run against Claude Desktop itself.
