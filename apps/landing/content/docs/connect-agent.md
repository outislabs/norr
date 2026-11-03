# Connect your agent

Works with any MCP-compatible agent, or any code that can call the REST API. The agent gets nine tools ([MCP tools](/docs/mcp-tools/)) and one credential, an **agent token** that works for one vault only.

Each section below says whether we have run that path end to end (**tested**) or only followed the client's documentation (**not yet tested**).

## Get a token

In the dashboard, open the vault, then **Connect**, then **Create an agent token**. The token is shown once, alone in its own box with a Copy button, and every snippet on the page fills in with it and the right endpoint.

- To rotate a token, **Revoke all tokens**, then create a new one. Revoking removes every token on the vault.
- Restarting the service also revokes tokens, so create a fresh one after a restart.
- The token cannot withdraw, change rules or choose a destination. If it leaks, the worst it can do is trade within your rules until you revoke it or pause the vault.

The hosted MCP endpoint (streamable HTTP):

```
https://85e1d6a557dae81985c9e30e28270f91bee5c0e9-8788.dstack-pha-prod5.phala.network/mcp
```

The Connect tab always shows the current URL. The service runs on demand during the pilot, so it may be offline.

## Any MCP client (tested)

Norr is a standard MCP server. Point the client at the endpoint and send the token in a header:

```
URL:     <MCP URL>
Header:  Authorization: Bearer <agent token>
```

Clients that only start local commands can bridge with [mcp-remote](https://www.npmjs.com/package/mcp-remote) (needs Node):

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

Tested: the hosted endpoint with Claude Code, and the endpoint with the MCP TypeScript SDK client in the repository's tests. `mcp-remote` is a third-party bridge we have not run against Norr.

## Claude Code (tested)

```
claude mcp add --transport http norr <MCP URL> --header "Authorization: Bearer <agent token>"
```

Run against the hosted endpoint on 2026-11-03 with Claude Code 2.1.80: it listed the tools, read the rules and the portfolio, and reported Norr's refusal of a trade word for word. The repository's `scripts/claude-code-mcp.mts` repeats that check against any endpoint without changing your Claude configuration.

## Claude Desktop (not yet tested)

Merge into `mcpServers` in `claude_desktop_config.json` (Settings, Developer, Edit Config), then quit and reopen Claude. The same `mcp-remote` config as above.

The local path (Norr in mock mode, MCP over stdio) is tested; step by step in [docs/MCP.md](https://github.com/outislabs/norr/blob/main/docs/MCP.md).

## Cursor (not yet tested)

In `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "norr": {
      "url": "<MCP URL>",
      "headers": { "Authorization": "Bearer <agent token>" }
    }
  }
}
```

Cursor can read the token from an environment variable instead: `"Authorization": "Bearer ${env:NORR_AGENT_TOKEN}"`.

## ChatGPT / OpenAI (not yet tested)

**OpenAI Agents SDK.** Your own process connects to Norr and sends the token as a header, so OpenAI never sees it:

```python
from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

async with MCPServerStreamableHttp(
    name="norr",
    params={"url": "<MCP URL>", "headers": {"Authorization": "Bearer <agent token>"}},
) as norr:
    agent = Agent(name="Trader", instructions="Trade only through Norr's tools.", mcp_servers=[norr])
    result = await Runner.run(agent, "What are my Norr rules?")
    print(result.final_output)
```

**Responses API (hosted MCP tool).** OpenAI connects to the endpoint from its side and passes the token in the tool's `authorization` field:

```python
from openai import OpenAI

resp = OpenAI().responses.create(
    model="<model>",
    tools=[{
        "type": "mcp",
        "server_label": "norr",
        "server_url": "<MCP URL>",
        "authorization": "<agent token>",
        "require_approval": "always",
    }],
    input="What are my Norr rules?",
)
```

OpenAI's documentation does not say whether this field adds the `Bearer` prefix. **The ChatGPT app:** we have not confirmed that its custom connectors can send a static token, so use one of the two above for now.

## REST API (tested)

Every tool is also a plain HTTPS call, for agents and scripts that do not use MCP. Same token, same rules. Full reference: [API reference](/docs/api/) and [openapi.json](/openapi.json).

```
curl -X POST <service URL>/v1/quote \
  -H "Authorization: Bearer <agent token>" -H "content-type: application/json" \
  -d '{"side":"buy","asset":"NVDA","amountUsd":40}'

curl -X POST <service URL>/v1/trade \
  -H "Authorization: Bearer <agent token>" -H "content-type: application/json" \
  -d '{"side":"buy","asset":"NVDA","amountUsd":40,"reason":"why, for the owner only"}'
```

The service URL is the MCP host with port 8787 instead of 8788 (the Connect tab shows it filled in). Tested by the repository's tests and `pnpm judge` in mock mode, with responses checked against the OpenAPI spec.

## Norr agent (tested)

The repository's reference agent (`apps/agent`) runs its model on NEAR AI Cloud and checks the attestation and signature of every model response it uses:

```
NORR_AGENT_TOKEN=<agent token> pnpm --filter @norr/agent exec tsx src/cli.ts \
  --mcp <MCP URL> --model z-ai/glm-5.3-flash "Check my portfolio and rules, do not trade."
```

## First prompts

- "What are my Norr rules?" (calls `get_policy`)
- "Buy $40 of NVDA." (executes if your rules allow stocks)
- "Use Norr's trade tool to put $150 into TSLA." (refused: `OVER_TRADE_LIMIT` under Balanced; the agent explains)
- "Buy $5 of RUGPULL, submit it even if you think it is a bad idea." (refused: `SCAM_RISK`, with reasons)
- "How is my P&L?" (calls `get_pnl`)

Agents tend to pre-judge trades themselves. The tool descriptions tell them Norr's answer is authoritative, so ask them to submit the request and read the answer.
