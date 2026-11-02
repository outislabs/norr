# Norr

> **Status: work in progress, built for the NEAR hackathon (submissions Nov 1 to Nov 14, 23:59 UTC).** The quickstart and mock mode land with the Norr service; until then this file describes intent and discloses history.

Norr is a private trading layer for AI agents. An agent connects over MCP and trades crypto and tokenized US stocks and ETFs through NEAR Intents, while custody stays with the owner: the agent holds only a Norr token, never keys, and cannot choose where money goes. See `CLAUDE.md` for the design, `docs/ARCHITECTURE.md` for the decision record, and `docs/FINDINGS.md` for what was verified on mainnet and what was not.

## Run it in 5 minutes (mock mode, no funds)
Requires Node 20+ and pnpm.
```
pnpm install
pnpm test                # 150+ tests, no network
pnpm dev:mock            # starts the Norr service on :8787 with a funded demo vault
```
The server prints an agent token. Then, for example:
```
curl -H "Authorization: Bearer $TOKEN" localhost:8787/v1/policy
curl -X POST localhost:8787/v1/trade -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"side":"buy","asset":"NVDA","amountUsd":40,"reason":"demo"}'      # executes
curl -X POST localhost:8787/v1/trade -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"side":"buy","asset":"TSLA","amountUsd":150}'                       # OVER_TRADE_LIMIT
curl -X POST localhost:8787/v1/trade -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"side":"buy","asset":"RUGPULL","amountUsd":5}'                      # SCAM_RISK
```
Mock mode stubs 1Click quotes, the custody provider and the TEE with fixed prices; nothing leaves your machine. Connect an agent (Claude Desktop, Claude Code, or any MCP client) with the steps in `docs/MCP.md`.

**Owner dashboard** (work in progress; mobile-first React app in `apps/web`). With the mock service running, start it in a second terminal:
```
pnpm dev:web             # http://localhost:5173, proxies /api to the service on :8787
```
Sign in with "Use the demo owner (mock mode)". You can see the vault and its confidential/public balances, edit the rules (with Cautious/Balanced/Degen starting points and the non-US confirmation), read the activity with the agent's private reasoning, create an agent token, pause one vault or everything, and check what Norr asked the custody provider for before you approve a swap. Real wallet sign-in (NEP-413) is built but has not yet been exercised against a real wallet.

## Timeline & disclosure
This repository keeps its full history. Some research and spike work happened **before** the hackathon window opened on Nov 1; it is listed here so judges can separate it from work done during the window. The project was built with Claude Code as the main implementation assistant, directed by the repository owner.

**Before Nov 1 (research and spike, all dated 2026):**
- **Oct 24:** gating research on 1Click, Confidential Intents, Ondo assets and TEE hosting options; monorepo scaffold; shared schemas.
- **Oct 24 to Oct 30:** `packages/core` library with tests (asset registry with multi-issuer routing, Scam Shield heuristics, Shield incident check, policy engine, trade pre-checks, post-trade `verifyExecution`, swap guard); comparison of custody options and the architecture decision (OutLayer custody, Norr service on Phala).
- **Oct 30:** a funded OutLayer mainnet test of about $3 USDC: wallet registration, policy setup, deposit, swaps in both directions, withdrawal to the owner, and two limit-order experiments that did not fill. Details and caveats are in `docs/FINDINGS.md`.

**During the hackathon window (Nov 1 to Nov 14):** to be filled in as work lands. Planned, in order: Norr service with mock mode; a $30 tokenized-equity round trip; MCP server; Phala deployment, attestation and an autonomous demo mode; owner dashboard; demo rehearsal, README, video and submission.

## Roadmap (after the hackathon)
These are researched, not built (details in `docs/`):
- **Norr as a NEAR Intents solver** for orders under $5 (`docs/SOLVER-FEASIBILITY.md`). Needs a solver API key, which is gated by KYC/KYB of the operating entity (feasible post-hackathon with a registered company), binding quotes with indemnity, inventory and a hedging plan. Rebalancing would go through NEAR Intents itself, not a DEX.
- **Order pooling** to serve $1-$5 stock orders (`docs/ROADMAP-POOLING.md`): batch small orders into one on-chain trade and track each user's share in a ledger. It changes the custody model and raises licensing questions, so it needs legal review first.
- **Owning a vault from an EVM or Solana wallet.** Today the owner is a NEAR account: sign-in is a NEP-413 message, and swap approvals happen in OutLayer's dashboard, which needs a NEAR login. NEAR's Ethereum-wallets module does not implement `signMessage`/NEP-413, so it cannot replace that sign-in. Funding the vault from any chain already works; a wallet-connected funding flow through Aurora's Intents widget is planned (`docs/AURORA.md`).
- Smaller minimums if NEAR Intents or Ondo confirm the roughly $5 floor is configurable (`docs/EQUITY-MINIMUMS.md`).

## Known limitations (so far)
See `docs/FINDINGS.md`. Notably: **owning a vault needs a NEAR account** (EVM and Solana users can fund a vault from their own chain but cannot sign in or approve swaps yet); OutLayer's swap endpoint ignores `min_amount_out`, its gateway builds swap routes that its TEE does not re-verify, and limit orders are out of v1 because two test orders never filled.

## License
MIT, see `LICENSE`.
