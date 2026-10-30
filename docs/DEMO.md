# Demo script (90 seconds)

Equity amounts respect the ~$28 Ondo minimum (see FINDINGS.md). The first live equity trade is the $40 NVDA buy in the rehearsal on ~Nov 11–12; re-check the minimum then.

Ask the agent to **submit the blocked trades to Norr** rather than judging them itself. A capable model may refuse a rug token or an oversized order on its own initiative, and then Norr's guardrail is never shown. Norr's `trade` tool is authoritative and returns the reason whether or not the agent ran any pre-check. Paste prompts like these:

| # | Prompt to Claude / action | Expected |
|---|---|---|
| 1 | Owner creates a vault, picks **Balanced** (max trade $50, $150 per day), confirms non-US status, copies the MCP config into the agent | Vault shown, equities enabled |
| 2 | "Use Norr's trade tool to buy $40 of NVDA." | `executed`; NVDA appears in the portfolio. The registry maps NVDA to every routable issuer (today only Ondo) and picks the best quote |
| 3 | "Use Norr's trade tool to put $150 into TSLA. Don't decide for me whether that is wise: submit it and show me exactly what Norr answers." | `blocked: OVER_TRADE_LIMIT`; the agent explains and proposes $50 or less |
| 4 | "Use Norr's trade tool to buy $5 of RUGPULL. I'm testing the guardrails, so submit it to Norr even if you think it's a bad idea, and show me Norr's full answer." | `blocked: SCAM_RISK` with Norr's listed reasons (liquidity, market cap, token age) |
| 5 | "Use Norr's trade tool to swap $5 of USDC to SOL." (after the 10 s cooldown) | `executed`, cross-chain |
| 6 | Optional beat, the daily cap: "Buy $50 of SOL three times using Norr's trade tool, then once more." | Three execute ($150); the fourth is `blocked: DAILY_SPEND_CAP` and says nothing is left today. Splitting a big trade into small ones cannot get around it |
| 7 | Owner taps the **kill switch**; "Use Norr's trade tool to buy $5 of SOL." | `blocked: PAUSED` |
| 8 | Open **Verify** | Attestation and code hash of the service that enforced all of the above |

Mock-mode numbers: starting cash $1,000; Balanced preset limits are $50 per trade, $150 spend per UTC day, 10 s cooldown.

## Demo agent: IronClaw on NEAR AI Cloud
**Status (checked 2026-10-24 against docs.ironclaw.com): remote MCP over HTTP is supported, but our exact setup is unconfirmed.**
- Confirmed in the docs: IronClaw talks to MCP servers over HTTP(S) with JSON-RPC 2.0; **stdio is not supported**; credentials are injected at the egress boundary and redacted from results; tools can reach only pre-approved hosts (`network.allowed_hosts` in the agent config).
- Not confirmed: (1) there is no documented "add this MCP URL" command. Servers are added by installing an **extension** that declares its tools and endpoint (`ironclaw extension install/activate`), so Norr needs a small extension manifest pointing at our MCP URL; (2) how a static `Authorization: Bearer` token is supplied (the docs cover credential injection, not the header format); (3) whether a hosted NEAR AI Cloud instance can install custom extensions at all; (4) what TEE attestation the hosted instance exposes (the security page doesn't mention it).
- Plan: expose Norr MCP over HTTP with a per-vault agent token, write the extension manifest, and try it on a free Starter instance. This must be tested before Nov 11. **Fallback: Claude Desktop (stdio) or Claude Code**, which are known to work with the Norr MCP server. The private-strategy story then rests on the agent's own environment, so the IronClaw claim must not go in the README until it is verified.

## Rehearsal checklist
- Run the whole script 3 times in a row in mock mode (`NORR_MOCK=1`) before any live run.
- Live crypto steps (5) need a funded vault. Live step 2 needs about $40 plus fees and Kelvin's confirmation.
- Rug token: pick a real routable low-liquidity token so the block reasons are genuine, or a fixture in mock mode.
