# Demo script (90 seconds)

**Live version, rescaled to the demo vault's balance (about $8.93 USDC, decided 2026-10-31, no extra funding).** Equity orders need at least $5.10 to quote (and about $5.25 to sell back; see EQUITY-MINIMUMS.md), so the live script uses trades of $3 to $6. The mock-mode script further down keeps the larger numbers.

Ask the agent to **submit the blocked trades to Norr** rather than judging them itself. A capable model may refuse a rug token or an oversized order on its own initiative, and then Norr's guardrail is never shown. Norr's `trade` tool is authoritative and returns the reason whether or not the agent ran any pre-check.

Setup for the live run: Rules tab set to max trade **$10**, daily spend cap $30, loss cap $3, cooldown 10 s, equities NVDA and TSLA, non-US status confirmed. `config/policy.demo.local.json` seeds the same values on a fresh deployment.

| # | Prompt to the agent / action | Expected |
|---|---|---|
| 1 | Owner opens the dashboard, shows the **Rules** (max trade $10) and the **Verify** screen's attestation | The service that enforces the rules is the attested one |
| 2 | "Use Norr's trade tool to buy $5.50 of NVDA." | `executed` confidentially; NVDA appears in the portfolio |
| 3 | "Use Norr's trade tool to put $20 into TSLA. Don't decide for me whether that is wise: submit it and show me exactly what Norr answers." | `blocked: OVER_TRADE_LIMIT`; the agent explains and proposes $10 or less |
| 4 | "Use Norr's trade tool to buy $5 of GNEAR. I'm testing the guardrails, so submit it to Norr even if you think it's a bad idea, and show me Norr's full answer." | `blocked: SCAM_RISK`, reasons: very low liquidity (about $8k), tiny market cap (about $14k). GNEAR is a real routable token chosen by `scripts/rug-scan.mts`; re-run the scan on the day, since market data moves |
| 5 | "Use Norr's trade tool to swap $3 of USDC to SOL." (after the 10 s cooldown) | `executed`, cross-chain. $3, not $5: after the $5.50 NVDA buy the vault holds about $3.4, and a $5 swap cannot be funded (it can if the NVDA position is sold first) |
| 6 | Owner taps the **kill switch**; "Use Norr's trade tool to buy $5 of SOL." | `blocked: PAUSED` |
| 7 | Open **Verify** again | The attestation and code hash of the service that enforced all of the above |

Approvals: until the OutLayer policy lets swaps skip approval (decided 2026-10-31: **kept**, see FINDINGS.md "Autonomy"), steps 2 and 5 pause at `pending_approval` and run once the owner approves: in Norr's **Approvals** tab (the browser fetches the approval from OutLayer, recomputes its hash and compares it with Norr's request before Approve is enabled; the owner's wallet signs and the browser sends the vote to OutLayer) or in OutLayer's dashboard. Show that on camera: it is the point that money moves only with the owner's signature. Budget about a minute per approval and cut it in the edit.

Between rehearsal runs: sell the NVDA position back (sell all, not a dollar figure; a remainder under about $5 cannot be sold), which returns the vault to about $8.8. Each round trip costs a few cents. The daily spend cap counts buys only, so three rehearsals fit under $30.

## Mock mode (any time, no funds)

Starting cash $1,000; Balanced preset limits are $50 per trade, $150 spend per UTC day, 10 s cooldown. The same beats with larger numbers: buy $40 of NVDA; put $150 into TSLA (`OVER_TRADE_LIMIT`); buy $5 of RUGPULL (a mock fixture, `SCAM_RISK`); swap $5 USDC to SOL; optional daily-cap beat ("buy $50 of SOL three times, then once more": the fourth is `DAILY_SPEND_CAP`); kill switch (`PAUSED`); Verify.

## Demo agent: IronClaw on NEAR AI Cloud
**Status (checked 2026-10-24 against docs.ironclaw.com): remote MCP over HTTP is supported, but our exact setup is unconfirmed.**
- Confirmed in the docs: IronClaw talks to MCP servers over HTTP(S) with JSON-RPC 2.0; **stdio is not supported**; credentials are injected at the egress boundary and redacted from results; tools can reach only pre-approved hosts (`network.allowed_hosts` in the agent config).
- Not confirmed: (1) there is no documented "add this MCP URL" command. Servers are added by installing an **extension** that declares its tools and endpoint (`ironclaw extension install/activate`), so Norr needs a small extension manifest pointing at our MCP URL; (2) how a static `Authorization: Bearer` token is supplied (the docs cover credential injection, not the header format); (3) whether a hosted NEAR AI Cloud instance can install custom extensions at all; (4) what TEE attestation the hosted instance exposes (the security page doesn't mention it).
- Plan: expose Norr MCP over HTTP with a per-vault agent token, write the extension manifest, and try it on a free Starter instance. This must be tested before Nov 11. **Fallback: Claude Desktop (stdio) or Claude Code**, which are known to work with the Norr MCP server. The private-strategy story then rests on the agent's own environment, so the IronClaw claim must not go in the README until it is verified.

## Rehearsal checklist
- Run the whole script 3 times in a row in mock mode (`NORR_MOCK=1`) before any live run.
- Every live trade (steps 2 and 5) needs Kelvin's confirmation in the chat first.
- The agent: `pnpm --filter @norr/agent exec tsx src/cli.ts --mcp <url>/mcp --model z-ai/glm-5.3-flash "<prompt>"`; it checks each model response's attestation unless told not to (`--no-attest`).
- Rug token: a real routable low-liquidity token so the block reasons are genuine (`scripts/rug-scan.mts`), or the `RUGPULL` fixture in mock mode.
