# Demo script (90 seconds)

Equity amounts respect the ~$28 Ondo minimum (see FINDINGS.md). The first live equity trade is the $40 NVDA buy in the rehearsal on ~Nov 11–12; re-check the minimum then.

| # | Say / do | Expected |
|---|---|---|
| 1 | Owner creates a vault, picks **Balanced** (max trade $50), confirms non-US status, copies the MCP config into the agent | Vault shown, equities enabled |
| 2 | "Buy $40 of NVDA." | `executed`; NVDA appears in the portfolio. Registry maps NVDA to every routable issuer (today only Ondo) and picks the best quote |
| 3 | "Put $150 into TSLA." | `blocked: OVER_TRADE_LIMIT`; the agent explains and proposes $50 or less |
| 4 | "Ape $5 into [rug token]." | `blocked: SCAM_RISK` with the listed reasons |
| 5 | "Swap $5 USDC to SOL." | `executed`, cross-chain |
| 6 | Owner taps the **kill switch**; ask the agent to trade | `blocked: PAUSED` |
| 7 | Open **Verify** | Attestation and code hash of the service that enforced all of the above |

## Demo agent: IronClaw on NEAR AI Cloud
**Status (checked 2026-10-24 against docs.ironclaw.com): remote MCP over HTTP is supported, but our exact setup is unconfirmed.**
- Confirmed in the docs: IronClaw talks to MCP servers over HTTP(S) with JSON-RPC 2.0; **stdio is not supported**; credentials are injected at the egress boundary and redacted from results; tools can reach only pre-approved hosts (`network.allowed_hosts` in the agent config).
- Not confirmed: (1) there is no documented "add this MCP URL" command. Servers are added by installing an **extension** that declares its tools and endpoint (`ironclaw extension install/activate`), so Norr needs a small extension manifest pointing at our MCP URL; (2) how a static `Authorization: Bearer` token is supplied (the docs cover credential injection, not the header format); (3) whether a hosted NEAR AI Cloud instance can install custom extensions at all; (4) what TEE attestation the hosted instance exposes (the security page doesn't mention it).
- Plan: expose Norr MCP over HTTP with a per-vault agent token, write the extension manifest, and try it on a free Starter instance. This must be tested before Nov 11. **Fallback: Claude Desktop (stdio) or Claude Code**, which are known to work with the Norr MCP server. The private-strategy story then rests on the agent's own environment, so the IronClaw claim must not go in the README until it is verified.

## Rehearsal checklist
- Run the whole script 3 times in a row in mock mode (`NORR_MOCK=1`) before any live run.
- Live crypto steps (5) need a funded vault. Live step 2 needs about $40 plus fees and Kelvin's confirmation.
- Rug token: pick a real routable low-liquidity token so the block reasons are genuine, or a fixture in mock mode.
