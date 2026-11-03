# Limitations and roadmap

## Known limitations

- **Custody trust.** For swaps, OutLayer's gateway builds the route and the deposit address, and its enclave does not re-check token or amount; its swap endpoint also ignores the minimum output. Norr checks every result afterwards and pauses the vault on a mismatch. Funds can still be lost to a dishonest or compromised gateway, up to what your limits allow.
- **Phala's key service** releases the VM's encrypted settings and is a second trust assumption.
- **Every swap needs your approval** in OutLayer, because swaps and withdrawals share one transaction type there.
- **Confidential swaps have no independent audit trail.** They are checked from balances and the provider's own report, and labelled `custody-reported`.
- **Funding and withdrawals are public**, and the custody provider and NEAR Intents operator see confidential trades. A funding transfer and the next hop can be correlated by timing and amount.
- **One vault per deployment, set up by the operator.** There is no self-serve vault creation yet.
- **Funding from other chains is quoted, not yet proven.** USDC on NEAR is proven on mainnet; the other chains were quoted live but not run with real funds.
- **Owning a vault needs a NEAR account.** EVM and Solana users can fund a vault but not sign in or approve swaps.
- **The Shield incident feed needs a key.** Without it the hosted service blocks every trade (it fails closed).
- **Limit orders are out of v1**: two test limit orders never filled.
- **Stock minimums move** with the market and the time of day.
- **Stock eligibility** follows third-party sources; this is not legal advice and has not been reviewed by counsel.
- **Scam Shield is heuristics**, not a guarantee; it blocks some legitimate tokens it cannot score.
- **Not audited**; small balances; the hosted service runs on demand.

## Roadmap

Planned, not built:

- **Self-serve hosted vaults.** Create a vault, its custody wallet and its first agent token from the dashboard, without an operator.
- **Multi-vault and client management.** Several vaults per owner (one per agent or strategy), and an operator view for people who run vaults for clients, with each client's data still sealed to that client.
- **TypeScript SDK.** A typed client for the [agent API](/docs/api/), generated from the OpenAPI spec, for agents that do not use MCP.
- **Verified P&L and Follow.** P&L that others can check, each trade backed by evidence, so an owner can publish a track record without revealing positions in real time, and others can follow it.

Researched, not built:

- **Owning a vault from an EVM or Solana wallet.** Needs an owner identity that is not a NEAR account and a way to approve custody requests.
- **Norr as a NEAR Intents solver** for orders under $5; gated by KYC/KYB of an operating entity.
- **Order pooling** for $1 to $5 stock orders; changes the custody model and needs legal review.
- **Smaller stock minimums** if NEAR Intents or the issuers make the floor configurable.

Details and evidence for each item are in the repository's `docs/` folder.
