# Norr documentation

Norr lets an AI agent trade crypto and tokenized US stocks for you, inside rules you set, without ever holding your keys, and without showing the public chain your strategy.

- **Your agent** connects over MCP with a token that works for one vault only. It can read the vault, ask for prices and request trades. It cannot withdraw, change your rules, or choose where money goes.
- **The Norr service** checks every request against your rules and a scam check, gets its own price quote, runs the trade through NEAR Intents (in the confidential layer when the vault's funds are there), and checks the result afterwards. It runs in an Intel TDX enclave on Phala that anyone can verify.
- **Your keys** stay with OutLayer's custody, which enforces its own limits, a withdrawal whitelist and your approval.

## Start here

- [Quickstart](/docs/quickstart/): sign in, fund the vault, connect an agent, watch what it does.
- [Connect your agent](/docs/connect-agent/): copy-ready MCP setup for Claude Code, Claude Desktop and other clients.
- [MCP tools](/docs/mcp-tools/): the nine tools, their answers, and every reason a trade can be blocked.
- [API reference](/docs/api/): the REST API behind the tools, from the OpenAPI spec.
- [Rules and limits](/docs/rules/): what you control, the presets, Scam Shield, stock eligibility.
- [Privacy model](/docs/privacy/): who sees what, stated plainly.
- [Verify the enclave](/docs/verify/): check the running code yourself, in the browser or a terminal.
- [FAQ](/docs/faq/)
- [Limitations and roadmap](/docs/limitations/)

For agents: [llms.txt](/llms.txt) and the whole documentation as one file, [llms-full.txt](/llms-full.txt). The source code and the evidence behind every claim are at [github.com/outislabs/norr](https://github.com/outislabs/norr).

Norr is a hackathon build: unaudited, run with small balances. Do not put in money you cannot lose.
