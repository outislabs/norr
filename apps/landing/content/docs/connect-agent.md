# Connect your agent

Works with any MCP-compatible agent, or any code that can call the REST API. The agent gets eleven tools ([MCP tools](/docs/mcp-tools/)) and one credential, an **agent token** that works for one vault only.

Each section below says whether we have run that path end to end (**tested**) or only followed the client's documentation (**not yet tested**).

## Get a token

In the dashboard, open the vault, then **Connect**, then **Create an agent token**. The token is shown once, alone in its own box with a Copy button, and every snippet on the page fills in with it and the right endpoint.

- To rotate a token, **Revoke all tokens**, then create a new one. Revoking removes every token on the vault.
- Restarting the service also revokes tokens, so create a fresh one after a restart.
- The token cannot withdraw, change rules or choose a destination. If it leaks, the worst it can do is trade within your rules until you revoke it or pause the vault.

The hosted MCP endpoint (streamable HTTP):

```
https://mcp.norr.finance/mcp
```

TLS for this name terminates inside the attested CVM, and its certificate is published with attested evidence, so you can check it is the enclave you are talking to ([Verify the enclave](/docs/verify/#check-the-domain)). The service runs on demand during the pilot, so it may be offline.

## Any MCP client (tested)

Norr is a standard MCP server. Point the client at the endpoint and send the token in a header:

```
URL:     <MCP URL>
Header:  Authorization: Bearer <agent token>
```

Clients that only start local commands can use the [@norrfi/mcp](https://www.npmjs.com/package/@norrfi/mcp) bridge (needs Node). It connects to `mcp.norr.finance` with your token, keeps no state and adds no tools of its own:

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

Set `NORR_MCP_URL` to use another endpoint (for example a local mock server).

Tested on 2026-11-03 against `mcp.norr.finance`: over HTTP with the MCP TypeScript SDK client and Claude Code, and through `npx -y @norrfi/mcp` from npm with both.

## Claude app: connector with sign-in (not yet tested)

No token to paste. In Claude (claude.ai, desktop or mobile), open **Settings, Connectors, Add custom connector**, and enter `https://mcp.norr.finance/mcp`. Claude sends you to Norr: sign in with your NEAR wallet, check which app is asking, pick the one vault it may use, and approve. It gets the same access as a token (read, quote, trade within your rules; never withdraw or change rules), with a one-hour access token that Claude refreshes. It shows under **Agents with access** in the vault's Connect tab, where you can revoke it.

This is MCP authorization (spec 2025-06-18): the MCP endpoint answers 401 with its protected-resource metadata, and the Norr service is the authorization server (dynamic client registration, PKCE S256, refresh-token rotation). Tested end to end against Norr's own OAuth client; not yet from the Claude app itself.

## Claude Code (tested)

```
claude mcp add --transport http norr https://mcp.norr.finance/mcp --header "Authorization: Bearer <agent token>"
```

Or through the bridge: `claude mcp add norr --env NORR_AGENT_TOKEN=<agent token> -- npx -y @norrfi/mcp`.

Run against `https://mcp.norr.finance/mcp` on 2026-11-03 with Claude Code 2.1.80: it listed the tools, read the rules, the portfolio and the P&L, and reported Norr's refusal of an over-limit trade word for word (`OVER_TRADE_LIMIT`), both over HTTP and through `npx -y @norrfi/mcp`. The repository's `scripts/claude-code-mcp.mts` repeats that check against any endpoint without changing your Claude configuration.

## Claude Desktop (not yet tested)

Merge the `npx @norrfi/mcp` config above into `mcpServers` in `claude_desktop_config.json` (Settings, Developer, Edit Config), then quit and reopen Claude. Not yet run inside Claude Desktop by us; the same command is tested with Claude Code.

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
curl -X POST https://api.norr.finance/v1/quote \
  -H "Authorization: Bearer <agent token>" -H "content-type: application/json" \
  -d '{"side":"buy","asset":"NVDA","amountUsd":40}'

curl -X POST https://api.norr.finance/v1/trade \
  -H "Authorization: Bearer <agent token>" -H "content-type: application/json" \
  -d '{"side":"buy","asset":"NVDA","amountUsd":40,"reason":"why, for the owner only"}'
```

The service URL is `https://api.norr.finance` (the Connect tab shows it filled in); TLS for it also terminates inside the attested CVM. Tested by the repository's tests and `pnpm judge` in mock mode, with responses checked against the OpenAPI spec.

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
