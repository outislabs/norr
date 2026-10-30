# Architecture (decision record, locked 2026-10-30)

Evidence for every claim below is in `docs/FINDINGS.md`. This file records what we decided and why.

## Decision
- **Custody and signing: OutLayer Agent Custody.** One OutLayer wallet per Norr vault (default master). Keys live in OutLayer's TEE. Capabilities, per-token limits, the address whitelist, approvals and freeze are enforced there, and only the owner can change them.
- **Norr service: Phala dstack** (generic Docker in a TDX TEE with remote attestation). It holds the OutLayer API key and runs everything OutLayer does not: registry with multi-issuer routing, Scam Shield, Shield incident feed, equity eligibility, the private per-vault policy, activity log and strategy, the MCP interface, and the post-trade check.
- **Agent:** holds only a Norr agent token for one vault. Demo agent: IronClaw on NEAR AI Cloud if its remote-MCP setup is verified, otherwise Claude Desktop.
- **Core stays independent.** `packages/core` is pure logic and never imports OutLayer. OutLayer sits behind an adapter in `packages/intents`.
- **Fallback:** Phala + Shade Agents with our own keystore, if a remaining test fails.

## Request flow
agent token → Norr: resolve asset → Shield feed → risk or eligibility → Norr policy → own 1Click quote (with `min_amount_out`, checked by `requireSwapBounds`) → OutLayer swap (approval per policy) → poll → `verifyExecution` against Norr's quote using 1Click's independent status → ledger. A mismatch trips the kill switch.

## What OutLayer does vs what Norr adds
| OutLayer | Norr |
|---|---|
| TEE wallet, signing, API key for the service | Agent tokens, one vault each |
| Per-token limits, whitelist, approvals, freeze (owner-set) | Private policy: trade size, daily spend cap, loss cap, cooldown, allowlists, equity %, eligibility |
| Gateway builds the 1Click route and deposit address | Asset registry, multi-issuer routing, Scam Shield, Shield feed |
| Gasless swaps and withdrawals | Post-trade verification and kill switch |

## Trust assumptions and known limitations
- OutLayer's gateway builds the route and deposit address; its TEE does not re-check token or amount for swaps. Limits and approvals bind an honest gateway. Norr can only detect tampering after the fact.
- `min_amount_out` is accepted but ignored by OutLayer's swap endpoint (executed quotes used 1% slippage). Limit orders may give an enforced minimum; untested.
- OutLayer's gateway sees every operation. Privacy is from the public chain and other users, not from the custody provider.
- Policy and documentation drift: re-verify each API shape live. Hourly/daily/monthly counters are best-effort under concurrency.

## Autonomous mode (demo)
Swaps skip approval within tight limits; `intents_withdraw` stays approval-gated and whitelisted to the owner. Details and the checks still to run are in `CLAUDE.md` §11.

## Owner API (dashboard backend)
`/owner/v1` is the API the dashboard uses. Sign-in is a NEAR wallet message signature (NEP-413): the server issues a one-time challenge, the wallet signs it, the server verifies the ed25519 signature and that the signing key is an access key of the claimed account (an RPC `view_access_key`), then returns a session token (12 hours; only its hash is kept). Each vault has an `owner` account; a session sees and changes only its own vaults (anything else is a 404). Owner calls: list and read vaults with a portfolio labelled by layer; edit the Norr rules (validated; the vault id cannot change; this is where the owner confirms non-US status); pause, resume and a kill switch that pauses all the owner's vaults; activity **including the agent's private reasoning**; "pending" swaps with exactly what Norr asked the custody provider for (tokens, amounts, request hash) so the owner can check the approval screen before signing; issue and revoke agent tokens; an audit log of owner actions; and a verify screen that says honestly there is no TEE attestation yet. Agent tokens cannot call it; owner sessions cannot call the agent API.

**Not yet tested against a real wallet.** The signature tests use keys generated in the test suite and a payload built exactly per the NEP-413 text; the first real check is signing in from a NEAR wallet app (`norrfi.near`). Reasoning is returned in plaintext to the authenticated owner; encrypting it to an owner-held key is planned (see `docs/PRIVACY.md`).

## Venues: confidential by default
Each vault has a `privacy` mode (`public`, `prefer` (default), `require`). Trades run in the confidential layer whenever the vault holds the funds there, and the Decision says which `venue` was used and how it was `verification`-checked. Public swaps are verified against 1Click's independent status; confidential swaps can only be checked against balances read before and after plus the custody provider's own report, which is weaker and labelled `custody-reported`. Shield, unshield and withdraw are owner-level actions in the custody adapter and are not exposed to agents. See `docs/PRIVACY.md` for what each layer hides and from whom.

## Shield modes
Default and the only production behavior: if the Shield incident feed cannot be read, trading is blocked (fail closed). A dev-only bypass (`SHIELD_MODE=dev-bypass`) exists for trying live trades while a SHIELD key is pending. It requires an explicit `NORR_ENV=dev` (unset counts as production), the service refuses to start with it under any other environment or in mock/demo mode, it covers only an unreachable feed (a reported incident still blocks), and it logs a warning on every evaluation and notes it in the ledger entry. Remove it from any demo or production config.

## Open items
Equity execution through OutLayer (quotes work), Confidential Intents execution, limit orders, autonomous-mode policy, Phala hosting and attestation, IronClaw as demo agent, sovereign vault.
