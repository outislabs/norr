# Norr

**Your agent trades. Nobody watches.**

Norr is a private trading layer for AI agents. An agent (Claude, ChatGPT, your own bot) connects over MCP and trades **crypto and tokenized US stocks and ETFs** across chains through **NEAR Intents**. Trades settle in the **Confidential Intents** layer when the vault holds its funds there, so pair, size and price stay off the public chain. The engine that enforces your rules runs in an **Intel TDX enclave on Phala** that anyone can check. The agent holds **one token, scoped to one vault**: it cannot withdraw, change the rules, or choose a destination.

**Site:** [norr.finance](https://norr.finance) · **Docs:** [norr.finance/docs](https://norr.finance/docs/) · **Dashboard:** [app.norr.finance](https://app.norr.finance) · **X:** [@norrfi](https://x.com/norrfi)

Built for the NEAR hackathon (Nov 1 to Nov 14, 2026). Tracks: Privacy & Private AI, Unstoppable DeFi, AI Security, Agent Economy. The project was built with Claude Code as the main implementation assistant, directed by the repository owner. Read [Timeline & disclosure](#timeline--disclosure) for exactly what was built when.

> Not audited software. Hackathon build, tiny balances. Do not put in money you cannot lose.

## What is live today

| | Status | Evidence |
|---|---|---|
| **Verified enclave** | Norr runs in a TDX confidential VM on Phala Cloud (production `dstack-0.5.12` OS image, images pinned by digest). Seven attestation checks pass against our own CVM. | [Verify it yourself](#verify-it-yourself); `docs/FINDINGS.md` |
| **Confidential trades** | Confidential swaps and a tokenized-stock round trip have run on mainnet through OutLayer custody, with tiny amounts. | $6 NVDAon buy and sell back, 2026-10-30, round trip cost 0.0719 USDC (about 1.2%); a 1.5 USDC to SOL and back swap; `docs/FINDINGS.md`, `docs/PRIVACY.md` |
| **Stocks and crypto from about $5** | Ondo tokenized stocks and crypto, 24/7. On liquid tickers (NVDAon, TSLAon, AAPLon, QQQon, AMZNon, GOOGLon) the confidential route quoted from $5.05; other tickers needed $26. The floor moves with the market. | `docs/EQUITY-MINIMUMS.md` (measured 2026-10-30) |
| **Owner dashboard** | Sign in with a NEAR wallet; fund the vault; edit the rules; read the agent's private reasoning; approve or reject custody requests in place (the browser fetches each approval from OutLayer, recomputes its hash and compares it with what Norr asked for before Approve is enabled; the signed vote goes straight to OutLayer); kill switch; status bar; Verify screen that works without signing in. | https://app.norr.finance |
| **MCP server** | Nine tools over stdio and streamable HTTP at `https://mcp.norr.finance/mcp` (TLS terminates inside the attested VM). Claude Code tested against it. | `docs/MCP.md`; `apps/mcp`; [norr.finance/docs/connect-agent](https://norr.finance/docs/connect-agent/) |
| **Private model for the agent** | The reference agent runs its model on NEAR AI Cloud and verifies the hardware-backed signature of every response it uses. | `apps/agent`; `docs/AGENT-MODELS.md` |
| **Self-serve vaults (public beta)** | Any NEAR account can create its own vault in the dashboard. Norr registers a custody wallet and seals its key in the enclave; the owner's own wallet stores the custody policy on chain, which makes the owner its controller (OutLayer's contract: the first account to store a policy controls it), so Norr can never change it. Safe default policy: confidential operations only, money can only go to the owner, owner approval (autonomous mode is the owner's choice, off by default). Beta limits: $100 per vault, one vault per account, terms accepted at creation, rate limits, an operator switch for new vaults. Built and tested end to end in mock mode; the first live self-serve vault is next. | `docs/MULTI-USER.md`; `apps/enclave/src/onboarding.ts` and its tests |
| **Claude app connector (OAuth)** | `mcp.norr.finance` supports MCP authorization: add it as a custom connector, sign in with your NEAR wallet on Norr's consent screen, pick one vault. Same scope as a pasted token; revocable in the Connect tab. Pasted tokens keep working for every other client. Tested against our own OAuth client; not yet from the Claude app. | `apps/enclave/src/oauth.ts`; `apps/mcp/src/http.ts` |
| **Mock mode** | The whole flow runs locally with no funds and no network, including creating a self-serve vault (each starts with $100 of pretend USDC) and the OAuth consent. | [Run it in 5 minutes](#run-it-in-5-minutes-mock-mode-no-funds) |

**What is not live, said plainly.** The NEAR Intents incident feed (Shield) needs a partner key that has not been granted. The incident feed is therefore an optional integration, decided by one deployment setting (`SHIELD_API_KEY`): without the key the hosted service runs every other check (rules, Scam Shield, eligibility, price sanity, post-trade verification), executes trades that pass them, and labels it on every answer: "Incident feed: not configured (partner key pending)" (`/health`, `get_policy`, every quote and trade result, the dashboard's status bar and Verify screen). With a key, the feed is checked last and fails closed as before. NEAR Intents publishes no keyless incident or status signal (checked 2026-11-04), so there is no lighter substitute. Every swap waits for the owner's approval (in Norr's Approvals tab) unless the owner chose autonomous mode. The deployment runs only when needed (a stopped CVM costs nothing), so the live check below may be offline; mock mode is always available.

## Verify it yourself

The service answers `/attestation?nonce=…` and `/info` publicly. The checks, run by the dashboard's Verify screen (https://app.norr.finance/#/verify, no account needed) or from a terminal:

```
pnpm install
pnpm exec tsx scripts/verify-attestation.mts https://api.norr.finance
```

1. The quote is a TDX quote.
2. It answers the random nonce you just sent (not a replay).
3. SHA-256 of the app configuration equals the measured `compose-hash` event.
4. Replaying the boot event log reproduces the quote's RTMR3.
5. The OS image is a production dstack image, not a debug one (a known debug image fails the check).
6. Every container image in the configuration is pinned by digest.
7. The quote's signature chain verifies up to Intel's root certificate. The dashboard does this in your browser with Phala's `dcap-qvl` compiled to WebAssembly: it fetches Intel-signed certificate data from Phala's PCCS (a cache that cannot forge it) and sends the quote nowhere. The terminal script asks Phala's verification API instead.

Observed on 2026-11-03 for this deployment (7/7 checks): git commit `443dc88b7c3dbb73c8483ad0a42ba6ed3601d682`, compose hash `074435c24e6d3d353d72b6c085319baa2932a4088e106c4ea39b072e82665394`, image `ghcr.io/outislabs/norr@sha256:3240dae9a7b97e66f56748daf8cf8fb8b99c0ec41362ba034985f4cc0c5f160f` (both services), plus `ghcr.io/dstack-tee/dstack-ingress:2.8@sha256:60e682449534715a2f2e5b72326ca4229209c8e26c931c6f34d27e02200ac086`.

**The domains, too.** `api.norr.finance` (the service) and `mcp.norr.finance` (the MCP endpoint) are served by Phala's dstack-ingress inside the CVM: TLS terminates there, and the certificates are published at `https://<domain>/evidences/` with a TDX quote over them. `pnpm exec tsx scripts/verify-domain.mts <domain> https://api.norr.finance` checks that the certificate your client sees is the attested one (both passed on 2026-11-03). Advanced: the CVM can also be reached directly through Phala's gateway, bypassing norr.finance DNS (URL in the docs, Verify the enclave).

**What this proves and what it does not.** It proves which code and images booted, on genuine TDX hardware. It does not prove what secrets the VM was given, and Phala's key service (which releases the VM's encrypted environment) is a trust assumption. Details: `docs/DEPLOY-PHALA.md`, `docs/FINDINGS.md`.

## Run it in 5 minutes (mock mode, no funds)

Requires Node 22 and pnpm 10 (`.node-version` and `packageManager` pin them).

```
pnpm install
pnpm judge               # typecheck, every test, the demo through a real MCP client, a dashboard build: PASS/FAIL per check
pnpm dev:mock            # the Norr service on :8787 with a funded demo vault
```

`AGENTS.md` maps every claim to the code, the tests and the live evidence.

The server prints an agent token. Then, for example (wait ten seconds between trades: the demo rules have a cooldown):

```
curl -H "Authorization: Bearer $TOKEN" localhost:8787/v1/policy
curl -X POST localhost:8787/v1/trade -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"side":"buy","asset":"NVDA","amountUsd":40,"reason":"demo"}'      # executes
curl -X POST localhost:8787/v1/trade -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"side":"buy","asset":"TSLA","amountUsd":150}'                       # OVER_TRADE_LIMIT
curl -X POST localhost:8787/v1/trade -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"side":"buy","asset":"RUGPULL","amountUsd":5}'                      # SCAM_RISK
```

Mock mode stubs 1Click quotes, the custody provider and the TEE with fixed prices; nothing leaves your machine. Connect an agent (Claude Desktop, Claude Code, or any MCP client) with `docs/MCP.md`. The full demo script is `docs/DEMO.md`.

Owner dashboard, in a second terminal:

```
pnpm dev:web             # http://localhost:5173, proxies /api to the service on :8787
```

Choose "Use the demo owner". You can see balances by layer, edit the rules, read the agent's reasoning, create an agent token with copy-ready MCP config, pause one vault or everything, and run the Verify screen (in mock mode there is no TEE, and it says so).

## How it works

```
 AI agent (Claude / ChatGPT / your bot)
        │  MCP over HTTPS, agent token scoped to ONE vault
        ▼
 ┌────────── Intel TDX confidential VM on Phala (attested) ───────────┐
 │  MCP endpoint (apps/mcp)  ─▶  Norr service (apps/enclave)          │
 │    auth · asset registry · Scam Shield / eligibility · policy      │
 │    quote · execute · verify · sealed ledger · /attestation         │
 └───────────────┬─────────────────────────────────┬──────────────────┘
                 │ OutLayer API (key sealed        │ 1Click API (read:
                 │ in the CVM)                     │ quotes, status)
                 ▼                                 ▼
   OutLayer custody wallet (keys in its TEE):   NEAR Intents /
   limits, address whitelist, owner approvals   Confidential Intents

 Owner dashboard (app.norr.finance) ── NEAR wallet sign-in ──▶ Norr service
```

Every `trade` runs these steps in order; any failing step returns `blocked` with a plain-language reason the agent can act on:

1. **Auth:** the agent token maps to exactly one vault.
2. **Resolve:** the asset registry maps a ticker (say `NVDA`) to every routable version (Ondo `NVDAon`, others if 1Click lists them).
3. **Risk:** Scam Shield for crypto, or eligibility for stocks (a price sanity check follows the quote). Scam Shield scores market data from DexScreener (liquidity, market cap, token age) and contract checks from GoPlus Security (honeypot, mint and freeze authority, owner privileges such as blacklisting or pausing unless ownership is renounced, buy and sell taxes, closed source); known majors are allowlisted. A token GoPlus cannot check (NEAR-native tokens, no data, GoPlus unreachable) gets a stated reason and a little extra risk, never a silent pass.
4. **Policy:** paused, per-trade size, daily spend cap, daily loss cap, cooldown, allowlists, equity share. Trades for one vault run one at a time, so parallel requests cannot slip past a cap.
5. **Incident feed (when configured):** last, for trades that pass every rule: an active NEAR Intents incident touching the asset blocks it, and so does a feed that cannot be read (fails closed). A trade that breaks a rule is refused with that rule's reason. Without a partner key the step is skipped and every answer says "Incident feed: not configured (partner key pending)".
6. **Quote:** Norr requests its own 1Click quote per venue: confidential first when the vault holds funds there, public only as a fallback (never under `privacy: require`).
7. **Execute and track:** the custody wallet signs; Norr polls to a final state.
8. **Verify:** every swap carries a positive `min_amount_out` from Norr's own quote and is checked afterwards. Public swaps are compared with 1Click's independent status; confidential swaps are checked against balances read before and after and the provider's report, and labelled `custody-reported`. A mismatch trips the kill switch.
9. **Log:** an encrypted ledger entry; the agent's reasoning is sealed to the owner.

The policy and risk logic is pure TypeScript in `packages/core`, tested exhaustively.

## Privacy model

Private from the public is not private from everyone. This is the honest table (`docs/PRIVACY.md` has the observations behind it).

| Data | Public chain observers | OutLayer (custody) | NEAR Intents operator and solvers | Norr service | Owner |
|---|---|---|---|---|---|
| A **confidential swap**: pair, size, price, balances | **Hidden** (confirmed on mainnet: no public balance change, no public transaction) | Sees all | Sees plaintext intents | Sees all | Yes |
| **Funding and withdrawing** the vault | **Visible**: a public transfer from the owner's account, and shielding is a public call on `intents.near` | Sees all | Sees all | Sees all | Yes |
| The agent's **stated reasoning** | n/a | No | No | Writes it, **cannot read it back**: sealed to a key derived from the owner's wallet signature (X25519 + AES-GCM) | Only the owner |
| Decisions, counters, policy | n/a | No | No | Yes (it must, to enforce caps; encrypted on disk with the service key) | Yes |
| The agent's model and prompts | n/a | n/a | n/a | n/a | Private if run on NEAR AI Cloud, whose responses the reference agent verifies; otherwise the agent host's own privacy |
| The **code** that enforces all this | Anyone can verify it (attestation) | n/a | n/a | n/a | n/a |
| That the traffic comes from Norr | Not private: Norr's partner key identifies it to 1Click and OutLayer | | | | |

## How NEAR is used

- **NEAR Intents (1Click API):** asset registry (`/v0/tokens`, including Ondo tokens), quotes, deposit addresses for funding from any chain, execution status, and the Shield incident feed.
- **Confidential Intents:** quotes with `CONFIDENTIAL_INTENTS` deposit, recipient and refund types; confidential swap, balance and withdraw through the custody wallet; funding straight into the confidential layer.
- **NEAR accounts:** each vault is a custody wallet owned by a NEAR account. Owner sign-in is a signed NEP-413 message checked against the account's access keys over NEAR RPC, bound to the dashboard's origin. Swap approvals are NEP-413 votes by the owner's NEAR account, signed in Norr's dashboard (or OutLayer's) and sent to OutLayer.
- **NEAR AI Cloud:** the reference agent's private model, with per-response attestation and signature checks.
- **OutLayer Agent Custody:** keys, signing and the hard backstop policy (below).

## Custody: what OutLayer does, what Norr adds

| OutLayer Agent Custody | Norr |
|---|---|
| Wallet keys and signing in its TEE | Agent tokens, one vault each; the MCP interface |
| Per-token limits, owner address whitelist, approval threshold, freeze (set by the owner in its dashboard; neither the agent nor Norr can change them) | Private policy: trade size, daily spend and loss caps, cooldown, allowlists, equity share |
| Builds the 1Click route and deposit address for swaps | Asset registry and multi-issuer routing, Scam Shield, Shield feed, equity eligibility, Norr's own quote |
| Gasless swaps and withdrawals | Post-trade verification, kill switch, encrypted ledger, attestation |

**Trust assumptions, stated without softening.** For swaps, OutLayer's gateway builds the route and the deposit address, and its TEE does not re-check token or amount; its swap endpoint also accepts but ignores `min_amount_out`. Limits and approvals bind an honest gateway, and Norr detects tampering after the fact. This is not trustless custody, and funds can still be lost to a dishonest or compromised gateway up to what the owner's limits allow. Phala's key service is a second trust assumption. Withdrawals are approval-gated and whitelisted to the owner, so the agent can never choose a destination.

## MCP tools

`list_assets`, `check_asset`, `get_market_data`, `get_quote` (dry run, no funds move), `trade`, `get_portfolio`, `get_pnl`, `get_policy`, `get_activity`. No tool can withdraw, change policy, or accept a destination address. Stdio for Claude Desktop and Claude Code, streamable HTTP for remote agents (`docs/MCP.md`).

## Repository layout

```
packages/core      pure logic: registry, risk, policy, swap guard, verification (no I/O)
packages/intents   1Click, OutLayer, Shield and balance clients
packages/shared    schemas, shared types, attestation checks
apps/enclave       the Norr service: agent API, owner API, attestation, sealed storage
apps/mcp           MCP server (stdio and streamable HTTP)
apps/agent         reference agent on NEAR AI Cloud with per-response attestation
apps/web           owner dashboard (Vite, React, Tailwind)
apps/landing       static landing page
deploy/            Phala compose file (images pinned by digest)
docs/              findings, privacy table, architecture, demo, deployment
scripts/           live trade runner, verify-attestation, research probes (live scripts need explicit flags)
```

## Known limitations

- **Custody trust** and **Phala key service trust**, as above.
- **Every swap needs the owner's approval.** On OutLayer, swaps and withdrawals share one transaction type (`confidential`), so approvals cannot be turned off for swaps alone (`docs/FINDINGS.md`, "Autonomy"). The owner approves in Norr's dashboard: first used live on 2026-11-04 with HOT Wallet (`docs/FINDINGS.md`).
- **Confidential swaps have no independent audit trail.** They are checked from balances and the provider's own report, and labelled `custody-reported`.
- **Funding and withdrawals are public**, and the custody provider and NEAR Intents operator can see confidential trades. A funding transfer and the next hop can be correlated by timing and amount.
- **Incident feed not configured**: the NEAR Intents partner key for the incident feed (Shield) has not been granted, so the hosted service does not check it. It says so on every answer; with a key it would be checked and fail closed. No keyless substitute exists.
- **Public beta limits.** Up to $100 per self-serve vault and one vault per NEAR account. Creating a vault costs the owner about 0.02 to 0.04 NEAR of on-chain storage for the custody policy (refundable). The custody provider's free tier allows 100 operations per wallet per day.
- **Self-serve vaults are new.** Built and tested in mock mode (including attempts to hijack a wallet's policy or store a weaker one); the first live self-serve vault has not been created yet.
- **Funding from other chains is quoted, not yet proven.** USDC on NEAR into the confidential balance is proven on mainnet (2026-10-31); routes from Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and Solana were quoted live on 2026-11-03 but not run with real funds.
- **Owning a vault needs a NEAR account.** EVM and Solana users can fund a vault from their own chain (the Fund tab), but cannot sign in or approve swaps yet: NEAR's Ethereum-wallets module does not implement `signMessage`/NEP-413 (`docs/AURORA.md`). The sign-in page points them to HOT Wallet, which gives a NEAR account alongside EVM and Solana ones.
- **Limit orders are out of v1**: two test limit orders never filled.
- **Small orders**: the stock minimum is a quote-time floor that moves (about $5 on liquid tickers at US market open, higher at other times and for other tickers).
- **Stock eligibility**: per third-party sources (NEAR Intents' docs are silent), Ondo's tokens are for non-US persons only. The owner confirms non-US status before equities are enabled, and the dashboard shows a disclaimer. This is not legal advice and has not been reviewed by counsel.
- **Scam Shield is a set of heuristics**, not a guarantee. It fails closed on tokens it cannot score (some legitimate tokens are blocked). GoPlus does not cover NEAR-native tokens, so for those only market data is scored, and the reasons say so. GoPlus is used without a key; it documents no free-tier rate limits or terms we could find, so lookups are cached for 10 minutes.
- **Not audited**, tiny balances, and the live deployment runs only when needed.

## Roadmap (after the hackathon)

Planned, not built:
- **Multi-vault and client management:** several vaults per owner (one per agent or strategy), and an operator view for people who run vaults for clients, with each client's data still sealed to that client.
- **TypeScript SDK:** a typed client for the agent API (generated from `apps/enclave/openapi.json`) for agents that do not use MCP.
- **Verified P&L and Follow:** P&L that others can check (each trade backed by its 1Click status or a confidential balance proof), so an owner can publish a track record without revealing positions in real time, and others can follow it.

Researched, not built (details in `docs/`):
- **Owning a vault from an EVM or Solana wallet**: needs an owner identity that is not a NEAR account and a way to approve custody requests; not possible with NEAR's Ethereum-wallets module as it stands.
- **Norr as a NEAR Intents solver** for orders under $5 (`docs/SOLVER-FEASIBILITY.md`); gated by KYC/KYB of an operating entity.
- **Order pooling** for $1 to $5 stock orders (`docs/ROADMAP-POOLING.md`); changes the custody model and needs legal review.
- Smaller minimums if NEAR Intents or Ondo confirm the floor is configurable (`docs/EQUITY-MINIMUMS.md`).

## Timeline & disclosure

This repository keeps its full history. **Most of the code was written on Oct 30 and 31, before the hackathon window opened on Nov 1.** The dates below come from the commit log, so judges can separate that work from what was done inside the window.

Organizers confirmed pre-window work is permitted. The hackathon rules count code from the 2026-10-19 announcement (HACKATHON.md, Q-001), so everything in this repository (research from Oct 24, first commit Oct 30) falls inside the window and there is no earlier baseline to separate.

**Before Nov 1 (2026):**
- **Oct 24:** gating research on 1Click, Confidential Intents, Ondo assets and TEE hosting; monorepo scaffold; shared schemas.
- **Oct 24 to Oct 30:** `packages/core` with tests (registry with multi-issuer routing, Scam Shield, Shield incident check, policy engine, swap guard, `verifyExecution`); custody options compared and the architecture decided (OutLayer custody, Norr service on Phala).
- **Oct 30:** a funded OutLayer mainnet test (about $3 USDC): wallet registration, policy, deposit, swaps both ways, withdrawal, and two limit-order experiments that did not fill. The same day: the Norr HTTP service and mock mode, the MCP server, the live trade runner, confidential trading (shield, confidential swap and withdraw, each recorded in `docs/FINDINGS.md`), the owner API and first dashboard, the $6 NVDAon confidential round trip, durable state, and encryption at rest with owner-sealed reasoning.
- **Oct 31:** funding through Norr's own 1Click quote; dashboard hosting on its own origin; container image and CI; the attestation endpoints, shared checks and Verify panel; the reference agent on NEAR AI Cloud with signature verification; rescaled demo script. Attestation checks were tested on real dstack quotes (from NEAR AI Cloud), which found and fixed a real bug in the RTMR3 replay.

**Inside the window (Nov 1 to Nov 14):**
- **Nov 1:** no commits.
- **Nov 2:** first deployment on Phala Cloud (a smoke CVM, then the production CVM on a production OS image); attestation checked for the first time against our own hardware; a startup fix found by the smoke test (the service now starts and retries when 1Click is unreachable, and blocks trades with `PRICING_UNAVAILABLE` meanwhile); a check that fails debug OS images; dashboard status bar, onboarding, Connect-agent page, value history, clearer approvals, and a Verify screen that works without signing in; the landing page; MIT license; this README; the dashboard hosted at app.norr.finance.
- **Nov 3:** landing page and dashboard redesigned (black and white, Geist), a strict Content-Security-Policy on the dashboard, the quote's signature chain verified in the browser (`dcap-qvl` WebAssembly), HOT sign-in tested on a phone against the live CVM, and funding from other chains (USDC on Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain or Solana, or ETH, SOL) through Norr's own 1Click quote. Aurora's widget was evaluated and not used: it cannot pay into the vault's confidential balance (`docs/AURORA.md`).
- **Nov 4:** GoPlus contract checks in Scam Shield; the incident feed became an optional, labelled integration; custom domains (api. and mcp.norr.finance, TLS inside the CVM, CAA pinned); `@norrfi/mcp` on npm; P&L and market data tools; the first trade on the hosted demo ($5.50 of NVDA, confidential); approvals inside Norr's dashboard (first live vote signed with HOT, $1.50 USDC to SOL); a ledger bug found live and fixed; and self-serve vaults with owner-signed custody policies, per-vault isolation, beta safeguards and OAuth for MCP connectors (`docs/MULTI-USER.md`).
- **Planned:** the first live self-serve vault, the first mainnet funding from another chain, demo rehearsal, video and submission.

## Built with

- **AI:** Claude Code (Anthropic) wrote most of the code, tests and docs, directed and reviewed by the repository owner. The reference agent runs its model on NEAR AI Cloud.
- **Libraries:** TypeScript, Node.js, pnpm, vitest, zod, Hono (`@hono/node-server`), the MCP TypeScript SDK (`@modelcontextprotocol/sdk`), `@phala/dstack-sdk`, `@phala/dcap-qvl-web`, `near-api-js`, NEAR Wallet Selector (core, modal UI, HOT, Meteor, MyNearWallet), React, Vite, Tailwind CSS, `@noble/curves` and `@noble/hashes`, `marked`, `qrcode-generator`, Geist fonts (`@fontsource`), and Phala's `dstack-ingress` container.
- **Services:** NEAR Intents (1Click API, Confidential Intents, Shield feed), OutLayer Agent Custody, Phala Cloud (dstack, TDX), NEAR AI Cloud, DexScreener (read-only market data), GoPlus Security (read-only token contract checks), Cloudflare Pages, GitHub Actions and GHCR.
- **Own earlier code:** none; everything is in this repository's history.

## Image provenance

Images are built by `.github/workflows/image.yml` from this repository and signed with build provenance (Sigstore, via GitHub). Check the deployed one:

```
gh attestation verify oci://ghcr.io/outislabs/norr@sha256:3240dae9a7b97e66f56748daf8cf8fb8b99c0ec41362ba034985f4cc0c5f160f --repo outislabs/norr
```

It confirms the image was built from commit `443dc88` by that workflow. `deploy/docker-compose.yml` pins it by digest, and the attestation above shows the CVM runs that compose file.

## License

MIT, see `LICENSE`.
