# Norr

> **Status: work in progress, built for the NEAR hackathon (submissions Nov 1 to Nov 14, 23:59 UTC).** The quickstart and mock mode land with the Norr service; until then this file describes intent and discloses history.

Norr is a private trading layer for AI agents. An agent connects over MCP and trades crypto and tokenized US stocks and ETFs through NEAR Intents, while custody stays with the owner: the agent holds only a Norr token, never keys, and cannot choose where money goes. See `CLAUDE.md` for the design, `docs/ARCHITECTURE.md` for the decision record, and `docs/FINDINGS.md` for what was verified on mainnet and what was not.

## Timeline & disclosure
This repository keeps its full history. Some research and spike work happened **before** the hackathon window opened on Nov 1; it is listed here so judges can separate it from work done during the window. The project was built with Claude Code as the main implementation assistant, directed by the repository owner.

**Before Nov 1 (research and spike, all dated 2026):**
- **Oct 24:** gating research on 1Click, Confidential Intents, Ondo assets and TEE hosting options; monorepo scaffold; shared schemas.
- **Oct 24 to Oct 30:** `packages/core` library with tests (asset registry with multi-issuer routing, Scam Shield heuristics, Shield incident check, policy engine, trade pre-checks, post-trade `verifyExecution`, swap guard); comparison of custody options and the architecture decision (OutLayer custody, Norr service on Phala).
- **Oct 30:** a funded OutLayer mainnet test of about $3 USDC: wallet registration, policy setup, deposit, swaps in both directions, withdrawal to the owner, and two limit-order experiments that did not fill. Details and caveats are in `docs/FINDINGS.md`.

**During the hackathon window (Nov 1 to Nov 14):** to be filled in as work lands. Planned, in order: Norr service with mock mode; a $30 tokenized-equity round trip; MCP server; Phala deployment, attestation and an autonomous demo mode; owner dashboard; demo rehearsal, README, video and submission.

## Known limitations (so far)
See `docs/FINDINGS.md`. Notably: OutLayer's swap endpoint ignores `min_amount_out`, its gateway builds swap routes that its TEE does not re-verify, and limit orders are out of v1 because two test orders never filled.
