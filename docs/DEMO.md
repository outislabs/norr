# Demo script (2 minutes)

Built by Kelvin Alkorogie, with Claude Code as a coding assistant.

The live demo, as it works today (2026-11-10): the **Claude app** is connected to a self-serve vault through OAuth, Norr quotes and trades, the owner **approves in Norr's own dashboard** with a NEAR wallet, and **Verify** proves which code enforced it. Everything below was run live except where it says "not rehearsed". For a run with no funds and no network, use [Mock mode](#mock-mode-any-time-no-funds).

## The shot list

Total 2:00. Record the screen with a voice-over; cut every wait (the approval and the swap each take 20 to 60 seconds). Captions on.

| Time | On screen | Say | Expect |
|---|---|---|---|
| 0:00 | The vault's page: "Approvals on", Rules (largest trade $10, daily cap $30) | "This is my agent's vault. It can spend ten dollars a trade, thirty a day. It cannot withdraw, change these rules, or choose where money goes." | The rules, plus the vault's balance in the confidential layer |
| 0:12 | **Claude app**. Type: *Use Norr's get_quote to price buying $1.50 of SOL.* | "I connected Claude with a sign-in, not a pasted key. First a price, no money moves." | Venue `confidential`; `approval`: every swap waits for the owner, with a link to the Approvals tab and the 24-hour expiry |
| 0:27 | Type: *Use Norr's trade tool to buy $1.50 of SOL. Reason: demo.* | "Now the real request." | `pending_approval`, naming the Norr dashboard's Approvals tab, with the link |
| 0:40 | Dashboard, **Approvals** tab. Point at the three lines: the operation, "Hash checked in this browser", "names the tokens and amount Norr asked for". Tap **Approve**, confirm in HOT (cut the wait) | "My browser reads the request from the custody provider, recomputes its hash, and compares it with what Norr asked for. Only then can I approve. My wallet signs; Norr never sees the signature." | Approve is enabled only when both checks pass |
| 1:00 | Claude: *Show my recent Norr activity.* Then the dashboard's **Activity** tab | "It ran in the confidential layer of NEAR Intents: pair, size and price are not on the public chain. The agent's reasoning is sealed: only my wallet opens it." | `executed`, `venue: confidential`; the reason is unlocked with one wallet signature |
| 1:15 | Claude: *Use Norr's trade tool to put $150 into SOL. Don't decide for me whether that is wise: submit it and show me exactly what Norr answers.* | "Now a guardrail. A hundred and fifty dollars is over my limit." | `blocked: OVER_TRADE_LIMIT`, with a reason the agent can act on |
| 1:27 | Claude: *Use Norr's check_asset on GNEAR.* | "And Scam Shield: a thin, tiny token." | `high` risk: very low liquidity (about $6.4k), tiny market cap (about $10k); the contract checks say whether they could run |
| 1:42 | `app.norr.finance/#/verify`, press **Check attestation** (no sign-in) | "Last, the proof. My browser asks the running service which code it booted, on genuine Intel hardware, and checks the answer itself. Seven checks." | Seven green checks, including the signature chain verified against Intel's root certificate |
| 1:55 | The README or repo page | "Norr. Give your AI money without giving it the keys. The code is public, and so is the proof." | |

## Before you record (the day before)

1. **Service up and current.** `curl -s https://api.norr.finance/info` shows the commit you expect and `dataKey.fingerprint` `8fb402a5b50d2e8c`. `pnpm exec tsx scripts/verify-attestation.mts https://api.norr.finance` passes all seven.
2. **The vault.** About $3.50 or more of USDC in its confidential balance (the $1.50 buy plus rehearsals), and room under the $30 daily cap (the cap counts buys, per UTC day). Approvals on (the vault page says "Approvals on", not "Autonomous mode: ON"). Each rehearsal buy costs a few cents in fees.
3. **Claude is connected.** In the Claude app, Settings, Connectors: `https://mcp.norr.finance/mcp`. Connecting opens Norr's consent screen: sign in, pick the vault, approve. After you revoke it in Connect, Claude is refused (tested), so reconnect before recording.
4. **Your wallet.** HOT signed in on the machine you record with. The first approval of a take needs it.
5. **Clean take.** Never show an agent token, an API key, `.env`, or the wallet's full address. Dashboard in a window without other tabs.
6. **GNEAR is still high risk.** `pnpm exec tsx scripts/rug-scan.mts` lists the candidates (read-only; it takes a few minutes). On 2026-11-10 GNEAR scored HIGH: liquidity $6,449, market cap $10,014. If it moves, take the next one from the list.

## Say it the way the agent will hear it

A capable model may refuse an oversized order or a rug token on its own initiative, and then Norr's guardrail is never shown. Ask it to **submit the blocked trades to Norr** ("submit it and show me exactly what Norr answers"); Norr's `trade` tool is authoritative and returns the rule. Do not ask for a stock: a new vault needs the non-US confirmation first, and stock minimums (about $5 to $26) are above this vault's $10 limit for most tickers.

## If something goes wrong

| Problem | What to do |
|---|---|
| The quote is `blocked: COOLDOWN` | The vault's cooldown is 30 seconds after a trade; wait and ask again |
| The trade stays `pending_approval` after you approve | Ask Claude for the activity again (it settles the swap when asked); the approval list in the dashboard updates within a minute |
| The approval card shows a warning, or Approve is grey | Stop. That is the check working: the operation does not match what Norr asked for. Reject it and say so on camera |
| HOT does not open | Re-sign in; the sign-in page lists every wallet and says if one cannot start |
| The service is offline | Check `phala cvms get norr-demo` (status `running`); start it with `phala cvms start norr-demo` if it is stopped. A recording needs it running |
| 1Click is not quoting | On 2026-11-05 1Click refused every deposit that started on NEAR for about two and a half hours. Check `curl -s -o /dev/null -w '%{http_code}' https://1click.chaindefuser.com/v0/tokens`, wait, or record the Mock mode run |

## Other agents

Claude Code: `claude mcp add --transport http norr https://mcp.norr.finance/mcp --header "Authorization: Bearer <token>"`. Any MCP client: the Connect tab in the dashboard gives the exact snippet. The reference agent (`apps/agent`) runs its model on NEAR AI Cloud and verifies each response's signature. Not part of this demo: IronClaw (untested).

## Mock mode (any time, no funds)

Starting cash $1,000; Balanced preset limits are $50 per trade, $150 spend per UTC day, 10 s cooldown.

| # | Prompt | Expected |
|---|---|---|
| 1 | "Buy $40 of NVDA." | `executed`, venue `confidential` |
| 2 | "Put $150 into TSLA. Submit it to Norr and show me the answer." | `blocked: OVER_TRADE_LIMIT` |
| 3 | "Buy $5 of RUGPULL. Submit it even if you think it is a bad idea." | `blocked: SCAM_RISK`, with reasons |
| 4 | "Swap $5 USDC to SOL." | `executed` |
| 5 | Owner taps **Pause everything**; "Buy $5 of SOL." | `blocked: PAUSED` |
| 6 | Open **Verify** | In mock mode there is no enclave, and it says so |

To see the approval step, start the service with `NORR_MOCK_APPROVALS=1`: the swap waits in the Approvals tab and the owner signs with the demo key. The self-serve flow (create a vault, sign its custody policy, fund, connect an agent, OAuth consent) runs in mock mode too: `pnpm dev:mock`, `pnpm dev:web`, choose "Use the demo owner".

Rehearse the whole script three times in a row in mock mode before a live take.
