# Final demo, video, X post and submission plan

Built by Kelvin Alkorogie, with Claude Code as a coding assistant.

Drafted 2026-11-02. Rules are from the organizers' `HACKATHON.md` (https://nearhackathon.com/HACKATHON.md), read the same day. Nothing here has been sent or posted. Personal values (name, email, wallet) are placeholders: they go in only when the owner submits, and the payload is never committed.

## What the rules require (checked against HACKATHON.md)

| Rule | Source | Where we stand |
|---|---|---|
| Public repository by 2026-11-14 23:59 UTC | Procedure 1 | Public since 2026-11-02 |
| Public X post that says it was built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, with the demo video (screenshots alone are not enough when judges cannot open the demo) | Procedure 2, Q-012 | Draft below; the owner posts it |
| Submit once, after the repo is public and the post is up; **cannot be edited**; window 2026-11-01 00:00 to 2026-11-14 23:59 UTC | Procedure 3 | Plan: submit on Nov 13 |
| Code counts from the 2026-10-19 announcement; list libraries and AI-written code in the README | Q-001, Q-005 | Done in the README ("Built with", "Timeline & disclosure") |
| Hosted demo is a plus; keep it up to 2026-11-18, ideally 2026-11-25 | Q-012 | Needs the CVM running until at least Nov 18 (see cost) |
| Claude Code and Codex screen first: "check that it runs and does what the README says" | Q-017 | Mock quickstart verified 2026-11-02 |
| Judging 2026-11-16 to 2026-11-18; prizes paid in NEAR to a mainnet account | Dates | Wallet address needed from the owner |

**Tracks to enter** (ids for the API): `privacy` (Privacy & Private AI), `security` (AI Security & Defense: "Give AI money without giving it the keys to everything" is our tagline), `defi` (Unstoppable DeFi), `agents` (Agent Economy).

## Dependencies and risks

| Risk | Effect | Plan |
|---|---|---|
| **Shield API key not here** | The deployed service blocks every trade (the Shield check runs before the policy, so even the guardrail demos show `SHIELD_INCIDENT`) | Ask NEAR Intents again on Nov 4; hard cut-off Nov 9. If it has not arrived: record the live part on a local service with the dev-only bypass, **say so on screen and in the post**, and show the deployed service only for Verify and the dashboard. Mock mode covers the full flow for judges |
| 1Click outage (seen on 2026-11-02, hours long) | Quotes fail | The service now starts and retries; on the day check `curl -s -o /dev/null -w '%{http_code}' https://1click.chaindefuser.com/v0/tokens` before recording |
| Stock minimums move with the market (about $5.05 at US open on Oct 30, $28 on a Saturday) | A $5.50 buy might not quote | Record and rehearse Wed Nov 11 to Fri Nov 13, 14:30 to 21:00 UTC (US market hours). **Do not plan anything on Sat Nov 14** |
| Each swap waits for the owner's approval | Adds about a minute per swap | Show it once on camera (it is the point), cut the wait |
| Claude Code to the remote MCP endpoint with a bearer header is untested | The agent step could fail | Test on Nov 4. The Norr agent (`apps/agent`, NEAR AI Cloud model) is the tested path and the default for the recording |
| Rug-token example changes (GNEAR liquidity moves) | `SCAM_RISK` might not trigger | Re-run `scripts/rug-scan.mts` on the day |
| HOT wallet sign-in on a phone is untested | Dashboard step could fail | Test on Nov 4 |
| Phala balance is $5 | CVM stops | Top up (below) |

## Schedule (UTC)

| Date | Work |
|---|---|
| Mon Nov 2 | Done: public repo, provenance signing, README, landing page built. Owner: `norr-landing` Pages project; Shield key chase; Aurora Studio key |
| Tue Nov 3 | Landing live, README links it; Aurora funding integration (needs the key); Aurora $1 to $2 mainnet test (owner confirms each transaction) |
| Wed Nov 4 | Test: Claude Code to the remote MCP endpoint, HOT sign-in on a phone, `pnpm test` on a clean clone. Ask NEAR Intents about Shield again |
| Thu Nov 5 to Sun Nov 8 | Fixes from those tests; mock-mode rehearsal x3; dashboard phone review; demo vault funded |
| **Mon Nov 9** | **Code freeze.** CI builds and signs the final image; pin its digest; redeploy the CVM; run `verify-attestation.mts`; update the README's observed values |
| Tue Nov 10 | Mock rehearsal x3 on the deployed dashboard; Shield decision made (key or labelled bypass) |
| Wed Nov 11 | Live rehearsal x3 during US market hours (each live trade needs the owner's confirmation in chat) |
| Thu Nov 12 | Record the video (two takes), edit |
| Fri Nov 13 | Post on X, check the post is public, **submit**. A day of buffer remains |
| Sat Nov 14 | Buffer only. Deadline 23:59 UTC |
| Nov 16 to 18 | Judging: keep the CVM running. Keep it through Nov 25 if the budget allows |

## Cost of the hosted demo

`tdx.small` is $0.0608 per hour all in (compute $0.058, 20 GB disk $0.0028). Running continuously from Nov 9 to Nov 18 is 10 days, about **$15**; to Nov 25 is 17 days, about **$25**. The CVM is stopped at the moment (storage still bills at about $0.07 a day). With $5 of balance, **top up to at least $30** before Nov 9. That stays under the $50 cap. After judging: `phala cvms delete --cvm-id norr-demo`.

Demo vault money: about $9 USDC is in it. Each live rehearsal round trip costs a few cents; three rehearsals and the recording fit.

## Live demo run of show

Setup (the day before): Rules tab set to max trade $10, daily cap $30, loss cap $3, cooldown 10 s, NVDA and TSLA allowed, non-US status confirmed. Vault holds about $9 USDC, confidential. Agent token created and revoked-then-reissued so no startup token is in play. Public logs off.

Exact beats and prompts are in `docs/DEMO.md` (live version). Order: Verify, Rules, buy $5.50 NVDA (approval on camera), $20 TSLA (`OVER_TRADE_LIMIT`), $5 GNEAR (`SCAM_RISK`), $3 USDC to SOL, kill switch (`PAUSED`), Verify again. Sell the NVDA back between takes (sell all, not a dollar figure).

## Video script (about 2 minutes)

Screen recording with voice-over. No architecture slides. Captions on, since many people watch muted.

| Time | On screen | Voice-over |
|---|---|---|
| 0:00 | Landing hero: "Your agent trades. Nobody watches." | "AI agents can trade now. Most of them leak their strategy, and hold the keys to your money. Norr is a private trading layer that fixes both." |
| 0:12 | Dashboard, Verify screen, press "Check attestation": seven checks go green | "The engine that enforces your rules runs in an enclave on Phala. This is my browser asking it to prove which code it booted. Nobody has to take my word." |
| 0:28 | Rules tab: max trade $10, daily caps | "I give the agent a token and a budget: ten dollars a trade, thirty a day. It cannot withdraw, change these rules, or pick where money goes." |
| 0:40 | Terminal or Claude: "Buy $5.50 of NVDA." The answer says pending approval | "Buy a tokenized Nvidia share. Money moves only when I approve." |
| 0:50 | OutLayer approval screen: compare with the dashboard's Approvals tab, approve (cut the wait) | "My custody provider asks me to sign, and the dashboard shows me what Norr actually asked for, so I can check before I do." |
| 1:00 | Agent: executed, confidentially. Dashboard overview: NVDAon under "Confidential" | "Done, in the confidential layer of NEAR Intents: pair, size and price are not on the public chain." |
| 1:12 | "Put $20 into TSLA" then `OVER_TRADE_LIMIT` | "Now the guardrails. Twenty dollars is over my limit, so it is refused, with a reason the agent can act on." |
| 1:22 | "Buy $5 of GNEAR": `SCAM_RISK` with reasons | "A thin, brand-new token: blocked as a likely scam, and the reasons are listed." |
| 1:34 | Kill switch, then "Buy $5 of SOL": `PAUSED` | "One tap pauses everything." |
| 1:44 | Landing "What we don't hide" section | "I will tell you what this does not hide: funding is public, and my custody provider sees every trade. It is all on the page." |
| 1:55 | Repo and `app.norr.finance/#/verify` | "Norr. Your agent trades. Nobody watches. The code is public, and so is the proof." |

Recording notes: record in US market hours; show the approval once; cut waits; keep the Verify screen on screen long enough to read the checks; never show a startup token, an API key or the `.env` file; blur the wallet address if wanted.

## X post drafts

Rules: say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon, attach the video; lead with the problem; one complete moment; say concretely what NEAR does; link the demo and repo; end with a real question. Optional tags: @NearLegion, @NearBuilders. Replace the bracketed items. The owner posts.

**Main post**
> Give an AI agent your money and it usually gets your keys and your strategy goes public.
>
> I built Norr at NEAR HACKATHON: your agent trades crypto and tokenized stocks through NEAR Intents' confidential layer, holds one token and cannot withdraw. The enclave enforcing its limits can be verified from your browser.
>
> [video]
>
> @NEARProtocol #NEARHackathon
> Repo: https://github.com/outislabs/norr
> Try the check: https://app.norr.finance/#/verify
>
> What would you want an agent to be unable to do with your wallet?

**Thread (replies, optional)**
1. > How NEAR is used: NEAR Intents (1Click) for quotes and cross-chain funding, Confidential Intents for trades that stay off the public chain, NEAR accounts for owner sign-in and approvals, NEAR AI Cloud for a private model whose responses we verify.
2. > What we don't hide: funding and withdrawals are public, and the custody provider and Intents operator can see confidential trades. Full table in the README.
3. > Try it with no money: `pnpm install && pnpm dev:mock` runs the whole flow locally. [repo link]

Short variant (265 characters, counting the link as 23):
> Built at NEAR HACKATHON: Norr lets an AI agent trade crypto and tokenized stocks privately via NEAR Intents, without ever holding your keys. The enclave enforcing its limits is verifiable in your browser. [video] @NEARProtocol #NEARHackathon https://github.com/outislabs/norr

Do not claim: "trustless", "cannot lose funds", that trades are hidden from custody or Intents operators, or that a live demo is up when the CVM is stopped.

## Submission payload (fill the placeholders, send only after the owner confirms)

Endpoint: `POST https://nearhackathon.com/api/applications` (or the form at https://nearhackathon.com/#apply). Generate `requestId` once (`uuidgen | tr A-Z a-z`) and reuse it on retries. Submit only when the repo is public and the X post is live; it cannot be edited; at most 2 submissions per email.

```json
{
  "requestId": "<uuid, generated once>",
  "projectName": "Norr",
  "leadName": "<LEAD NAME>",
  "email": "<EMAIL>",
  "size": "1",
  "tracks": ["privacy", "security", "defi", "agents"],
  "nearAddress": "<MAINNET NEAR ACCOUNT FOR PRIZES>",
  "projectUrl": "https://github.com/outislabs/norr",
  "demoUrl": "<URL OF THE PUBLIC X POST>",
  "idea": "<text below>"
}
```

`idea` (20 to 2000 characters; 1,973 after the 2026-11-03 edit, so keep edits short):

> Norr is a private trading layer for AI agents. An agent (Claude, ChatGPT or your own bot) connects over MCP and trades crypto and tokenized US stocks and ETFs through NEAR Intents. When the vault holds its funds in the confidential layer, trades settle there, so pair, size and price stay off the public chain. The agent holds one token scoped to one vault: it cannot withdraw, change the rules or choose a destination.
>
> What is live: the Norr service runs in an Intel TDX confidential VM on Phala. Its attestation endpoints are public, and the dashboard's Verify screen (no sign-in needed) checks the quote, freshness, configuration hash, boot event log, production OS image, image digests and Intel's signature chain, all in the browser. Custody is an OutLayer wallet per vault, with owner-set limits, a withdrawal whitelist and owner approval for every swap. Norr adds the asset registry with multi-issuer routing, Scam Shield, the NEAR Intents incident feed, equity eligibility, per-vault rules (trade size, daily spend and loss caps, cooldown, allowlists), a kill switch, post-trade verification of every swap, and an encrypted ledger where the agent's reasoning is sealed to the owner's wallet. The owner dashboard covers funding from any chain, rules, activity, approvals and agent setup. A reference agent runs its model on NEAR AI Cloud and verifies each response's hardware-backed signature.
>
> Mainnet evidence, with tiny balances: confidential swaps, and a $6 tokenized Nvidia buy and sell back (cost about 1.2%).
>
> NEAR's role: Intents and 1Click for quotes and cross-chain funding, Confidential Intents for private trades, NEAR accounts for sign-in and approvals, NEAR AI Cloud for the private model.
>
> Honest limits are in the README: the custody provider sees every operation and builds swap routes its enclave does not re-check, funding is public, owning a vault needs a NEAR account, and it is unaudited. Run it with no funds: `pnpm install && pnpm dev:mock`.

## Pre-submit checklist

- [ ] CVM running, `scripts/verify-attestation.mts` passes, README "observed" values match the deployed image
- [ ] Shield key set (or the labelled-bypass fallback decided and stated)
- [ ] `pnpm install && pnpm test && pnpm dev:mock` pass on a clean clone; the README curl examples work
- [ ] README links norr.finance (once live), the video and the X post
- [ ] Video public, under the post, with the required tags in the post text
- [ ] Payload validated (`size` exactly `1`, tracks from the list, `nearAddress` lowercase, URLs under 300 characters), printed for the owner, sent only after their confirmation
- [ ] CVM kept running to Nov 18 (ideally Nov 25), then deleted
