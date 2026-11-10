# Submission

Built by Kelvin Alkorogie, with Claude Code as a coding assistant.

Updated 2026-11-10 from the organizers' live rules, https://nearhackathon.com/HACKATHON.md (it has no date or version line, and it says to read it again before submitting). **Deadline: 2026-11-14 23:59 UTC.** Nothing here has been sent or posted. Personal values are not in this file and the payload is never committed: they live in `config/submission.local.json` (gitignored), and `scripts/submission-check.mts` validates them and prints the payload without sending anything.

## What the rules require, from the live file

| Rule | Source in HACKATHON.md | Where we stand (2026-11-10) |
|---|---|---|
| The repository is public by 2026-11-14 23:59 UTC; judges cannot open a private one | Procedure 1 | Public. An anonymous clone with no credentials succeeded today |
| A public X post that says it was built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, with the demo video or screenshots; "screenshots are not enough when judges cannot open the demo" | Procedure 2, Q-012 | Draft below. **Kelvin records and posts it** |
| Submit once, after the repo is public and the post is up. The API answers 403 outside 2026-11-01 00:00 to 2026-11-14 23:59 UTC. A submission cannot be edited; mistakes go through https://nearhackathon.com/request-changes | Procedure 3 and 4 | Plan: submit Nov 13 |
| Libraries and AI code are allowed and must be listed in the README | Q-005 (quoted below) | README "Built with" lists libraries and services; the credits line names Claude Code. See the note below |
| Hosted demo is a plus: keep it up to 2026-11-18, ideally 2026-11-25 | Q-012 | The engine must stay running (cost below) |
| Claude Code and Codex screen every project (reproducibility, feature check); humans decide | Q-017, Procedure 1 | `pnpm judge` passes on a clean clone; the README quickstart runs as written |
| One submission per repository; at most 2 per email | Submission API (409) | Not yet submitted |

**Q-005, word for word:**
> **Q-005. Libraries, templates, boilerplate?** All allowed, including own pre-hackathon libs and AI code. List in README; own old libs count as baseline.

The file states no penalty and does not mark the listing optional. The README's credits line ("Built by Kelvin Alkorogie, with Claude Code as a coding assistant.") names Claude Code but does not say it wrote code. If you want the line to say that, the shortest wording is: "Built by Kelvin Alkorogie, with Claude Code (AI) writing much of the code, tests and docs." Your decision; not changed.

**What the file says the agent must never do without the human's explicit confirmation:** send the submission (print the full JSON first and wait for a yes; one attempt per project), post on X, make the repository public or push, sign transactions or deploy to mainnet, commit secrets.

## The fields (`POST https://nearhackathon.com/api/applications`, JSON, up to 12000 bytes)

Tracks entered, as you chose: `privacy`, `security`, `defi`, `agents`. Do not send any other field (`website` is a spam trap).

| Field | Rule | Value | Status |
|---|---|---|---|
| `requestId` | UUID, generated once and reused on retries | `uuidgen \| tr A-Z a-z` | Generate once; keep it in `config/submission.local.json` |
| `projectName` | 2 to 80 characters | `Norr` | Filled from the repository; confirm |
| `leadName` | 2 to 80 characters | | **Kelvin provides** (the credits line says Kelvin Alkorogie) |
| `email` | valid, max 160, at most 2 submissions per email | | **Kelvin provides** |
| `size` | exactly one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+` | `1` | Solo builder per the project notes; confirm |
| `tracks` | one or more of `defi`, `thesis`, `privacy`, `business`, `swarms`, `security`, `agents`, `realworld`, `games`, `nfts`, `memecoins`, `social`, `open` | `["privacy","security","defi","agents"]` | Filled, as you chose |
| `nearAddress` | 2 to 64 characters, lowercase, `^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$`; a mainnet account the team controls | | **Kelvin provides** (the organizers say never to invent one) |
| `projectUrl` | http(s) URL of the public repository, max 300, unique | `https://github.com/outislabs/norr` | Filled; public |
| `demoUrl` | http(s) URL of the public demo post, max 300 | | **Kelvin provides** after posting |
| `idea` | 20 to 2000 characters | below (1,832) | Drafted; confirm |
| `consent` | `true`, only after the human agreed | | **Kelvin**: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |

`idea`:

> Norr is a private trading layer for AI agents. An agent (the Claude app, Claude Code, ChatGPT or any MCP client) trades crypto and tokenized US stocks through NEAR Intents for one vault, inside rules the owner sets, without ever holding the keys. When the vault's funds are in the confidential layer, trades run there, so pair, size and price stay off the public chain.
>
> How NEAR is used: NEAR Intents (1Click) for quotes, cross-chain funding and execution; Confidential Intents for private trades; NEAR accounts for owner sign-in (NEP-413) and for approving every swap. A NEAR account is also each vault's on-chain controller: the owner's wallet stores the vault's custody policy on OutLayer's contract, so only the owner can change it. NEAR AI Cloud runs the reference agent's private model.
>
> Why it is safe to try: keys live in OutLayer's TEE custody, behind an owner whitelist, per-trade and daily limits and the owner's approval. Norr adds Scam Shield (market data plus GoPlus contract checks), refusal of look-alike tokens, per-vault rules, a kill switch and a check of every swap after it runs. The agent's token cannot withdraw, change rules or choose a destination. The Norr service runs in an Intel TDX VM on Phala, and anyone can verify its code from the browser: seven attestation checks, no sign-in.
>
> Live on mainnet with small amounts: confidential swaps, a tokenized Nvidia buy and sell-back, swaps approved in the dashboard with a NEAR wallet, a self-serve vault whose policy the owner stored on chain, and the Claude app connected through OAuth. Anyone can run the whole flow in mock mode.
>
> Honest limits are in the README: custody is not trustless (OutLayer's gateway builds swap routes), funding and withdrawals are public, and this is unaudited beta software. Try it with no funds: pnpm install && pnpm dev:mock.

### Validate, print, then send (only after Kelvin says yes)

1. Put the values in `config/submission.local.json` (gitignored): the field names above, `consent` last.
2. `pnpm exec tsx scripts/submission-check.mts` checks every rule above, prints the exact JSON and the character counts, and sends nothing.
3. Send it yourself, or tell me to, after you have read the printed payload:
   `curl -sS -X POST https://nearhackathon.com/api/applications -H 'Content-Type: application/json' -d @config/submission.local.json`
4. A 201 means saved. 400 lists the fields to fix (resend with the same `requestId`); 403 means closed or cross-site (do not retry); 409 means the repository or email was already used (do not change the link to get around it; use request-changes); 503 means wait a minute and resend with the same `requestId`.

## The demo post (Kelvin records and posts)

Required: says it was built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, attaches the demo video. Lead with the user problem; show one complete moment; say concretely what NEAR does; link the demo and the repo; end with a real question. Optional tags: @NearLegion, @NearBuilders. The script to record is [DEMO.md](DEMO.md) (2 minutes).

**Main post**
> Give an AI agent your money and it usually gets your keys, and your strategy goes public.
>
> I built Norr at NEAR HACKATHON: Claude trades crypto through NEAR Intents' confidential layer, holds one token, cannot withdraw, and every swap waits for my wallet's approval. The enclave enforcing its limits can be verified from your browser.
>
> [video]
>
> @NEARProtocol #NEARHackathon
> Repo: https://github.com/outislabs/norr
> Verify it yourself: https://app.norr.finance/#/verify
>
> What would you want an agent to be unable to do with your wallet?

**Thread (optional replies)**
1. > How NEAR is used: NEAR Intents (1Click) for quotes, cross-chain funding and execution; Confidential Intents for trades that stay off the public chain; NEAR accounts for sign-in, approvals and as each vault's on-chain controller; NEAR AI Cloud for a private model whose responses we verify.
2. > What we don't hide: funding and withdrawals are public, and the custody provider and the Intents operator can see confidential trades. The full table is in the README.
3. > Try it with no money: `pnpm install && pnpm dev:mock` runs the whole flow locally. [repo link]

**Short variant** (265 characters, a link counted as 23):
> Built at NEAR HACKATHON: Norr lets an AI agent trade crypto and tokenized stocks privately via NEAR Intents, without ever holding your keys. The enclave enforcing its limits is verifiable in your browser. [video] @NEARProtocol #NEARHackathon https://github.com/outislabs/norr

Do not claim: "trustless", "cannot lose funds", that trades are hidden from the custody provider or the Intents operator, or that a live demo is up when the engine is stopped.

## Keeping the hosted demo up

Q-012: keep it to 2026-11-18, ideally 2026-11-25. At the `tdx.small` rate of $0.0608 an hour, the rate recorded on 2026-11-02, from Nov 10 that is about **$12 to Nov 18** and about **$22 to Nov 25**. Check the Phala balance covers it. The service is running now; if it is ever stopped, `phala cvms start norr-demo`. Delete the CVM after the window.

## Pre-submission checklist

Verified on 2026-11-10 unless marked for Kelvin.

| Check | Result |
|---|---|
| Secret scan: no known secret value from `.env`, `deploy/.env.phala` or `config/*.local.*` appears in any of the 101 commits; none of the standard key patterns (OutLayer keys, agent and owner tokens, PEM blocks, JWTs, NEAR secret keys, cloud and API keys) appears anywhere in history; no `.env`, local config, data or key file is tracked | Pass. The only matches were two policy-limit numbers inside random TDX quote data and the demo vault's public account id |
| A personal NEAR account name appeared in three test files; replaced. It remains in older commits (the repository's history is not rewritten) | Fixed in files; history is Kelvin's call |
| Repository public | Pass: an anonymous clone with no credentials worked |
| Clean clone: `pnpm install --frozen-lockfile`, typecheck, all 667 tests, `pnpm judge` | Pass, at the current HEAD |
| README quickstart as written (policy, $40 NVDA executes confidentially, $150 TSLA `OVER_TRADE_LIMIT`, `RUGPULL` `SCAM_RISK`) | Pass |
| Links in the README, AGENTS.md, docs and landing content: 44 external URLs | Every one a reader would click returns 200. The others are authenticated API endpoints (401), bare API or RPC roots, npmjs.com (403 to scripts) and CSP hostnames in the deploy docs |
| Live attestation, `scripts/verify-attestation.mts https://api.norr.finance` | 7 of 7 pass; commit `eaad960` |
| Verify page in a real browser, no sign-in, Check attestation | 7 passed, 0 failed, 0 skipped; no console errors |
| TLS terminates inside the enclave, `scripts/verify-domain.mts` for api. and mcp.norr.finance | Both pass |
| Enclave data key stable across a redeploy, a restart and a new image | Fingerprint `8fb402a5b50d2e8c` every time |
| npm: `@norrfi/mcp@0.1.0` run from the registry through an MCP client | Lists all 10 tools; policy, `about_norr`, `SCAM_RISK` and `OVER_TRADE_LIMIT` work. It does not forward the connect-time instructions (documented) |
| Docs site and `llms.txt` match the repository | Pass on every page checked; the credits line is in `llms-full.txt` |
| Sign-in picker lists every wallet; Claude connector revoke refuses the agent | Confirmed by Kelvin |
| Hosted signups | Closed (invited accounts only): `GET /beta` says `signupsOpen: false`. Kelvin decides whether to open them before submitting |
| Demo video recorded, public post up, `demoUrl` known | **Kelvin** |
| `leadName`, `email`, `nearAddress`, consent | **Kelvin** |
| Payload checked with `scripts/submission-check.mts`, printed, confirmed | **Kelvin**, then send |

## Schedule (UTC)

| Date | Work |
|---|---|
| Tue Nov 10 | Features frozen. This checklist; demo script |
| Wed Nov 11 | Rehearse [DEMO.md](DEMO.md) three times in mock mode, then once live (each live trade needs Kelvin's confirmation) |
| Thu Nov 12 | Record the video (two takes), edit |
| Fri Nov 13 | Post on X, check the post is public, validate the payload, **submit**. A day of buffer remains |
| Sat Nov 14 | Buffer only. Deadline 23:59 UTC |
| Nov 16 to 18 | Judging: keep the engine running (ideally to Nov 25) |
