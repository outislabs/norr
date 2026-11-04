# Limitations and roadmap

## Known limitations

- **Custody trust.** For swaps, OutLayer's gateway builds the route and the deposit address, and its enclave does not re-check token or amount; its swap endpoint also ignores the minimum output. Norr checks every result afterwards and pauses the vault on a mismatch. Funds can still be lost to a dishonest or compromised gateway, up to what your limits allow.
- **Phala's key service** releases the VM's encrypted settings and is a second trust assumption.
- **Every swap needs your approval** (in Norr's Approvals tab or OutLayer's dashboard), because swaps and withdrawals share one transaction type in OutLayer.
- **Confidential swaps have no independent audit trail.** They are checked from balances and the provider's own report, and labelled `custody-reported`.
- **Funding and withdrawals are public**, and the custody provider and NEAR Intents operator see confidential trades. A funding transfer and the next hop can be correlated by timing and amount.
- **Public beta limits.** Up to $100 per vault and one vault per NEAR account. Creating a vault costs about 0.02 to 0.04 NEAR of on-chain storage for its custody policy (refundable). The custody provider's free tier allows 100 operations per wallet per day.
- **Self-serve vaults are new.** Built and tested in mock mode; the first live self-serve vault has not been created yet.
- **The Claude app connector (OAuth)** is tested against Norr's own OAuth client, not yet from the Claude app itself.
- **Funding from other chains is quoted, not yet proven.** USDC on NEAR is proven on mainnet; the other chains were quoted live but not run with real funds.
- **Owning a vault needs a NEAR account.** EVM and Solana users can fund a vault but not sign in or approve swaps.
- **The incident feed is not configured.** The NEAR Intents partner key for it has not been granted, so the hosted service does not check it; every answer says "Incident feed: not configured (partner key pending)". With a key it is checked and fails closed.
- **Limit orders are out of v1**: two test limit orders never filled.
- **Stock minimums move** with the market and the time of day.
- **Stock eligibility** follows third-party sources; this is not legal advice and has not been reviewed by counsel.
- **Scam Shield is heuristics**, not a guarantee; it blocks some legitimate tokens it cannot score.
- **Not audited**; small balances; the hosted service runs on demand.

## Roadmap

Planned, not built:

- **Multi-vault and client management.** Several vaults per owner (one per agent or strategy), and an operator view for people who run vaults for clients, with each client's data still sealed to that client.
- **TypeScript SDK.** A typed client for the [agent API](/docs/api/), generated from the OpenAPI spec, for agents that do not use MCP.
- **Verified P&L and Follow.** P&L that others can check, each trade backed by evidence, so an owner can publish a track record without revealing positions in real time, and others can follow it.

Researched, not built:

- **Owning a vault from an EVM or Solana wallet.** Needs an owner identity that is not a NEAR account and a way to approve custody requests.
- **Norr as a NEAR Intents solver** for orders under $5; gated by KYC/KYB of an operating entity.
- **Order pooling** for $1 to $5 stock orders; changes the custody model and needs legal review.
- **Smaller stock minimums** if NEAR Intents or the issuers make the floor configurable.

Details and evidence for each item are in the repository's `docs/` folder.
