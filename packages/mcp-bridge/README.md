# @norrfi/mcp

Connect any stdio MCP client (Claude Desktop, Claude Code, Cursor, your own agent) to [Norr](https://norr.finance), the private trading layer for AI agents, with one command.

```
NORR_AGENT_TOKEN=<your agent token> npx -y @norrfi/mcp
```

The bridge forwards your agent's tool calls to Norr's hosted MCP endpoint (`https://mcp.norr.finance/mcp`, TLS terminated inside an attested Intel TDX enclave). It keeps no state and adds no tools of its own. Your token is sent only to that endpoint.

Get an agent token in the Norr dashboard: [app.norr.finance](https://app.norr.finance), your vault, **Connect**. A token works for one vault and cannot withdraw, change rules or choose a destination.

This is not something you run on its own: your AI app starts it. Run by hand without a token, it explains this and exits; run by hand with a token, it prints one line saying it is waiting for an MCP client.

**Using the Claude app or claude.ai?** Add `https://mcp.norr.finance/mcp` as a connector instead (Settings, Connectors). No token or npx needed: you approve the connection in the Norr dashboard.

## Claude Desktop

In `claude_desktop_config.json`, under `mcpServers`:

```json
{
  "mcpServers": {
    "norr": {
      "command": "npx",
      "args": ["-y", "@norrfi/mcp"],
      "env": { "NORR_AGENT_TOKEN": "<your agent token>" }
    }
  }
}
```

Quit and reopen Claude. Eleven Norr tools appear: `about_norr`, `list_assets`, `check_asset`, `get_market_data`, `get_quote`, `trade`, `exit_position`, `get_portfolio`, `get_pnl`, `get_policy`, `get_activity`.

## Claude Code

```
claude mcp add norr --env NORR_AGENT_TOKEN=<your agent token> -- npx -y @norrfi/mcp
```

## Settings

| Variable | Default | |
|---|---|---|
| `NORR_AGENT_TOKEN` | (required) | The agent token from the dashboard. |
| `NORR_MCP_URL` | `https://mcp.norr.finance/mcp` | Another Norr endpoint, e.g. your own deployment or `http://127.0.0.1:8788/mcp` for local mock mode. Must be https unless it is localhost. |

Logs go to stderr; stdout carries the MCP protocol.

## Links

- Docs: [norr.finance/docs](https://norr.finance/docs/), including the [tool reference](https://norr.finance/docs/mcp-tools/)
- Source: [github.com/outislabs/norr](https://github.com/outislabs/norr) (`packages/mcp-bridge`)
- Verify the enclave yourself: [app.norr.finance/#/verify](https://app.norr.finance/#/verify)

MIT licensed. Hackathon build, unaudited: use small balances.
