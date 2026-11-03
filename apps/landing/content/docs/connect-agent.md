# Connect your agent

Norr speaks MCP (Model Context Protocol). Any MCP client can use it: Claude Code, Claude Desktop, or your own agent. The agent gets nine tools ([MCP tools](/docs/mcp-tools/)) and one credential, an **agent token** that works for one vault only.

## Get a token

In the dashboard, open the vault, then **Connect**, then **Create an agent token**. The token is shown once, with copy-ready configuration for each client below, already filled in with your token and the right endpoint.

- To rotate a token, **Revoke all tokens**, then create a new one. Revoking removes every token on the vault.
- Restarting the service also revokes tokens, so create a fresh one after a restart.
- The token cannot withdraw, change rules or choose a destination. If it leaks, the worst it can do is trade within your rules until you revoke it or pause the vault.

## Remote endpoint

The hosted service exposes MCP over streamable HTTP. The agent sends its token as `Authorization: Bearer <token>` on every request; the endpoint forwards it to the Norr service for that request and stores nothing.

```
https://85e1d6a557dae81985c9e30e28270f91bee5c0e9-8788.dstack-pha-prod5.phala.network/mcp
```

The Connect tab always shows the current URL. The service runs on demand during the pilot, so it may be offline.

## Any stdio client: `npx @norrfi/mcp`

For clients that start MCP servers as a local command (Claude Desktop, Claude Code, Cursor and most others), the [@norrfi/mcp](https://www.npmjs.com/package/@norrfi/mcp) bridge connects to the hosted endpoint with your token. It keeps no state and adds no tools of its own.

```json
{
  "mcpServers": {
    "norr": {
      "command": "npx",
      "args": ["-y", "@norrfi/mcp"],
      "env": { "NORR_AGENT_TOKEN": "<agent token>" }
    }
  }
}
```

Claude Code: `claude mcp add norr --env NORR_AGENT_TOKEN=<agent token> -- npx -y @norrfi/mcp`. Set `NORR_MCP_URL` to use another endpoint.

## Claude Code

```
claude mcp add --transport http norr <MCP URL> --header "Authorization: Bearer <agent token>"
```

Check `claude mcp add --help` for your version. Not yet run against the hosted endpoint by us; if it does not connect, test the endpoint with the MCP Inspector.

## Claude Desktop

Claude Desktop reaches a remote server through the `mcp-remote` bridge (needs Node). Merge this into `mcpServers` in `claude_desktop_config.json`, then quit and reopen Claude:

```json
{
  "mcpServers": {
    "norr": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "<MCP URL>", "--header", "Authorization:${NORR_AUTH}"],
      "env": { "NORR_AUTH": "Bearer <agent token>" }
    }
  }
}
```

## Local, no funds (stdio, tested)

Run the service in mock mode and start the MCP server as a local process. This path is covered by the repository's end-to-end tests.

```
NORR_MOCK=1 NORR_MOCK_AGENT_TOKEN=norr_agent_mock_demo_local_0001 pnpm dev:mock
```

Claude Code:

```
claude mcp add norr --env NORR_API_URL=http://localhost:8787 --env NORR_AGENT_TOKEN=norr_agent_mock_demo_local_0001 -- /ABSOLUTE/PATH/TO/norr/node_modules/.bin/tsx /ABSOLUTE/PATH/TO/norr/apps/mcp/src/stdio.ts
```

Claude Desktop: the same command and environment as an `mcpServers` entry; step-by-step in [docs/MCP.md](https://github.com/outislabs/norr/blob/main/docs/MCP.md). The pinned mock token is a public demo value; never use it for a live vault.

## Other clients and your own agent

Any MCP client that supports streamable HTTP and a custom header works with the remote endpoint. The repository's reference agent (`apps/agent`) runs its model on NEAR AI Cloud and checks the attestation and signature of every model response it uses:

```
NORR_AGENT_TOKEN=<agent token> pnpm --filter @norr/agent exec tsx src/cli.ts \
  --mcp <MCP URL> --model z-ai/glm-5.3-flash "Check my portfolio and rules, do not trade."
```

## First prompts

- "What are my Norr rules?" (calls `get_policy`)
- "Buy $40 of NVDA." (executes if your rules allow stocks)
- "Use Norr's trade tool to put $150 into TSLA." (refused: `OVER_TRADE_LIMIT` under Balanced; the agent explains)
- "Buy $5 of RUGPULL, submit it even if you think it is a bad idea." (refused: `SCAM_RISK`, with reasons)

Agents tend to pre-judge trades themselves. The tool descriptions tell them Norr's answer is authoritative, so ask them to submit the request and read the answer.
