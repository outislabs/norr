# Connect an agent to Norr (MCP)

Norr exposes eleven tools over MCP: `about_norr`, `list_assets`, `check_asset`, `get_market_data`, `get_quote`, `trade`, `exit_position`, `get_portfolio`, `get_pnl`, `get_policy`, `get_activity`. The agent holds only a Norr **agent token**, scoped to one vault. No tool can withdraw, change rules or choose a destination.

First start the Norr service. For a no-funds try-out: `pnpm dev:mock`, which prints an agent token (default API on `http://localhost:8787`).

## Claude Desktop (stdio), macOS, mock mode
1. Start Norr in a terminal and leave it running. Pinning the token means the Claude config does not change when you restart:
   ```
   cd /ABSOLUTE/PATH/TO/norr
   NORR_MOCK=1 NORR_MOCK_AGENT_TOKEN=norr_agent_mock_demo_local_0001 pnpm dev:mock
   ```
   The pinned token is a public demo value that only works in mock mode (no funds). Never reuse it for a live vault.
2. Open the config: Claude, Settings, Developer, Edit Config (the file is `~/Library/Application Support/Claude/claude_desktop_config.json`).
3. Add an `mcpServers` entry next to the keys already in the file (merge it in, do not replace the file). Use absolute paths, because Claude Desktop starts apps with a minimal `PATH`; `which node` gives the first path:
   ```json
   "mcpServers": {
     "norr": {
       "command": "/usr/local/bin/node",
       "args": [
         "/ABSOLUTE/PATH/TO/norr/node_modules/tsx/dist/cli.mjs",
         "/ABSOLUTE/PATH/TO/norr/apps/mcp/src/stdio.ts"
       ],
       "env": {
         "NORR_API_URL": "http://localhost:8787",
         "NORR_AGENT_TOKEN": "norr_agent_mock_demo_local_0001"
       }
     }
   },
   ```
4. Quit Claude completely (Cmd+Q, closing the window is not enough) and reopen it.
5. Check: Settings, Developer should list `norr` as running, and the tools icon in a new chat should show eleven Norr tools. Logs are in `~/Library/Logs/Claude/` (`mcp-server-norr.log`).
6. Try: "What are my Norr rules?", "Buy $40 of NVDA", "Put $150 into TSLA", "Ape $5 into RUGPULL", then after ten seconds "Swap $5 of USDC to SOL". To see the kill switch, run the `curl` shown in the terminal where Norr started (it prints a dev-only admin token), then ask for another trade.

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
