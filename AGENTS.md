# AGENTS.md

For AI agents and reviewers reading this repository (Claude Code, Codex and others). Humans: start with `README.md`.

## What Norr is

A private trading layer for AI agents. An agent connects over MCP with a token scoped to one vault and trades crypto and tokenized US stocks through NEAR Intents (Confidential Intents where the vault holds funds). Rules (trade size, daily caps, allowlists, cooldown, kill switch) and a scam check are enforced by the Norr service, which runs in an Intel TDX confidential VM on Phala that anyone can attest. Keys live with OutLayer's custody; the agent's token can never withdraw, change rules, or choose a destination.

## Check it in one command

```
pnpm install
pnpm judge          # about 2 minutes; no funds, no keys, no network
```

It runs, and prints PASS/FAIL for each check with the file that proves it:

1. Typecheck of both TypeScript projects.
2. The whole test suite (vitest).
3. The demo as an agent sees it: a real MCP client spawns `apps/mcp/src/stdio.ts` over stdio and trades against the Norr service in mock mode. Expect NVDA $40 executed, TSLA $150 `OVER_TRADE_LIMIT`, a rug token `SCAM_RISK`, a trade inside the cooldown `COOLDOWN`, SOL $5 executed, then P&L per asset (`get_pnl`) and the market data Scam Shield scored (`get_market_data`).
4. The owner side over HTTP: NEP-413 sign-in, the agent token refused on owner routes, funding from another chain (the recipient is the vault even when the request names another), a wrong-chain refund address refused, the kill switch (the next trade returns `PAUSED`), and an honest 503 for attestation in mock mode.
5. A production build of the dashboard and its generated Content-Security-Policy.

Last line on success: `PASS: 21/21 checks passed`. `pnpm judge --no-tests` skips step 2 (about 40 s instead of 2 minutes).

## Try it by hand (do X, see Y)

| Do | See |
|---|---|
| `pnpm dev:mock` | The service on :8787 prints an agent token (mock mode: fixed prices, nothing leaves the machine). |
| `curl -H "Authorization: Bearer $TOKEN" localhost:8787/v1/policy` | The vault's rules: max trade $50, cooldown 10 s. |
| `POST /v1/trade {"side":"buy","asset":"NVDA","amountUsd":40,"reason":"demo"}` | `executed`, venue `confidential`. |
| `POST /v1/trade {"side":"buy","asset":"TSLA","amountUsd":150}` | `blocked`, `OVER_TRADE_LIMIT`, with a plain-language message. |
| `POST /v1/trade {"side":"buy","asset":"RUGPULL","amountUsd":5}` | `blocked`, `SCAM_RISK`, with the reasons. |
| `pnpm dev:web`, open http://localhost:5173, "Use the demo owner" | The owner dashboard: balances by layer, rules, the agent's activity, Fund (pick a chain), Connect (MCP config), Pause everything, Verify. Below the demo vault, **Create your vault** walks the self-serve flow (terms, custody policy signed by the owner, activation); a new mock vault starts with $100 of pretend USDC. |
| Connect Claude Desktop or Claude Code with `docs/MCP.md` | Nine tools; ask it to buy $150 of TSLA and it reports the block. |
| `pnpm exec tsx scripts/verify-attestation.mts <service URL>` against the live CVM (URL in README) | Seven attestation checks, including Intel's signature chain. Only while the CVM is running. |

## Repository map

| Path | What it is |
|---|---|
| `packages/core` | Pure logic, no I/O: asset registry and multi-issuer routing, Scam Shield, Shield incident check, policy engine, swap guard, `verifyExecution`, funding sources. Exhaustively unit-tested. |
| `packages/intents` | 1Click client (quotes, deposits, status), OutLayer custody client, and mock rails for mock mode. |
| `packages/shared` | zod schemas and types (`Policy`, `TradeRequest`, `Decision`, block codes), attestation checks. |
| `apps/enclave` | The Norr service (Hono): agent API, owner API, trade pipeline, sealed ledger, attestation endpoints, mock mode. |
| `apps/mcp` | MCP server (stdio and streamable HTTP), a thin proxy to the service. |
| `apps/web` | Owner dashboard (Vite, React, Tailwind): sign-in, vaults, rules, activity, approvals, fund, connect, verify. |
| `apps/agent` | Reference agent on NEAR AI Cloud that verifies each model response's signature. |
| `apps/landing` | The landing page at norr.finance (static). |
| `scripts/` | `judge.mts` (this check), `verify-attestation.mts`; scripts that touch mainnet require explicit flags and the owner's confirmation. |
| `deploy/` | Docker Compose for the Phala CVM, images pinned by digest. |
| `docs/` | Findings, architecture, privacy model, demo, deployment, submission plan. |

## Where each claim is proven

| Claim | Code | Tests | Live evidence (mainnet or deployed) |
|---|---|---|---|
| The agent can never withdraw, change rules or choose a destination | `apps/mcp/src/tools.ts`, `apps/enclave/src/app.ts` | `apps/mcp/src/tools.test.ts`, `apps/enclave/src/app.test.ts` | Custody policy: `docs/FINDINGS.md` (OutLayer policy sections) |
| The incident feed is a labelled deployment setting: not configured means skipped and said on every answer; configured means fail-closed | `packages/core/src/shield.ts`, `apps/enclave/src/app.ts` | `pipeline.test.ts`, `app.test.ts`, `live.test.ts` | `curl https://api.norr.finance/health` (`incidentFeed`) |
| Rules are enforced before every trade (size, daily spend and loss caps, cooldown, allowlists, equity %, pause) | `packages/core/src/policy.ts`, `packages/core/src/pipeline.ts` | `packages/core/src/policy.test.ts`, `pipeline.test.ts` (every block code is reachable) | `pnpm judge` step 3 |
| Scam Shield blocks risky tokens (market data and GoPlus contract checks; nothing passes silently) | `packages/core/src/risk.ts`, `contract-risk.ts`, `packages/intents/src/goplus.ts` | `risk.test.ts`, `contract-risk.test.ts`, `goplus.test.ts` | `docs/FINDINGS.md`, "Real \"rug\" token for the live demo" |
| Every swap has a positive `min_amount_out` and is checked after execution | `packages/core/src/swap-guard.ts`, `verify.ts` | `swap-guard.test.ts`, `verify.test.ts` | `docs/FINDINGS.md`, first live swaps (OutLayer ignores the bound, which is why the post-trade check exists) |
| Trades run in the Confidential Intents layer | `packages/core/src/confidential.ts`, `apps/enclave/src/trade.ts` | `confidential.test.ts` | `docs/FINDINGS.md` and `docs/PRIVACY.md`: confidential swaps and a $6 NVDAon round trip on 2026-10-30 |
| Tokenized stocks across issuers | `packages/core/src/registry.ts` | `registry.test.ts` | `docs/FINDINGS.md` section 1 and the NVDAon round trip |
| Funding from any chain lands confidential, the vault is always the recipient | `packages/core/src/funding-sources.ts`, `apps/enclave/src/owner/routes.ts`, `packages/intents/src/oneclick.ts` | `funding-sources.test.ts`, `owner.test.ts`, `clients.test.ts` | Dry quotes from 7 chains: `docs/AURORA.md` (outcome). A mainnet funding from another chain is pending (README timeline). |
| The agent's reasoning is readable by the owner only | `apps/enclave/src/seal.ts`, `apps/web/src/lib/seal.ts` | `seal.test.ts` (both) | `docs/PRIVACY.md` |
| The service runs in an attested TDX VM on a production image | `packages/shared/src/attestation.ts`, `apps/enclave/src/attestation.ts` | `attestation.test.ts` | README "Verify it yourself" (observed values); `docs/FINDINGS.md`, Phala deploy |
| `api.norr.finance` and `mcp.norr.finance` terminate TLS inside the attested CVM | `deploy/docker-compose.yml` (dstack-ingress, pinned) | `scripts/verify-domain.mts <domain> https://api.norr.finance` (live) | Both passed on 2026-11-03 (`docs/FINDINGS.md`) |
| The quote's signature chain is verified in the browser | `apps/web/src/lib/qvl.ts` | `apps/web/src/lib/qvl.test.ts` (a real quote from our CVM verifies; one flipped byte fails) | Live: 7/7 on app.norr.finance against the running CVM, 2026-11-03 (`docs/FINDINGS.md`) |
| The dashboard has a strict CSP | `apps/web/src/lib/csp.ts`, `apps/web/vite.config.ts` | `csp.test.ts` | `curl -I https://app.norr.finance` |
| Images are built in CI with signed provenance | `.github/workflows/image.yml` | | `gh attestation verify oci://ghcr.io/outislabs/norr@sha256:… --repo outislabs/norr` (README "Image provenance") |
| Anyone can create a vault; its owner, not Norr, controls the custody policy (owner's wallet stores it; activation checks the chain and the stored policy) | `apps/enclave/src/onboarding.ts`, `packages/core/src/custody-policy.ts`, `packages/intents/src/outlayer-provision.ts` | `onboarding.test.ts` (flow, hijack and weaker-policy refusals, frozen wallet), `custody-policy.test.ts` | Contract rule read from `out-layer/outlayer` `contract/src/wallet.rs`; demo wallet controller `norrfi.near` on chain (`docs/MULTI-USER.md`) |
| One owner can never read or act on another's vault | `apps/enclave/src/owner/routes.ts`, `tenants.ts`, `tokens.ts`, `persist.ts` (per-vault files bound to the vault id) | `onboarding.test.ts` (every owner `:id` route answers 404 to another owner; tokens; files moved between vaults do not decrypt) | (mock and tests) |
| Public-beta safeguards: deposit cap, terms, operator switch, rate limits | `apps/enclave/src/beta.ts`, `trade.ts` (`VAULT_CAP`) | `onboarding.test.ts`, `pipeline.test.ts` | `GET https://api.norr.finance/beta` (after the next redeploy) |
| MCP clients can connect with OAuth, scoped to one vault, revocable | `apps/enclave/src/oauth.ts`, `apps/mcp/src/http.ts`, `apps/web/src/pages/AuthorizePage.tsx` | `oauth.test.ts`, `apps/mcp/src/e2e.test.ts`, `apps/web/src/pages/setup.test.tsx` | Not yet run from the Claude app |

## Mock versus live

Mock mode (`NORR_MOCK=1`, `pnpm judge`, `pnpm dev:mock`) stubs 1Click, the custody provider and the TEE with fixed prices. Everything in the tables above that says "Tests" or `pnpm judge` runs there. Claims about mainnet (confidential swaps, the stock round trip, attestation of the real CVM) cannot be reproduced without funds and keys; their evidence is recorded with dates and request ids in `docs/FINDINGS.md` and `docs/PRIVACY.md`, and the attestation can be re-checked by anyone while the CVM is running.

## Rules for agents working in this repo

- Never send a mainnet transaction. Scripts that can (`scripts/live-trade.mts`, funding helpers) need the owner's explicit confirmation.
- Never commit secrets: `.env`, `deploy/.env.phala` and `config/*.local.json` are gitignored.
- Every module ships with tests; run `pnpm judge` before proposing a change.
- Honest limitations are in README "Known limitations". Do not describe custody as trustless.
