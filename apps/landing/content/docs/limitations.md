# Limitations and roadmap

## Known limitations

- **Custody trust.** For swaps, OutLayer's gateway builds the route and the deposit address, and its enclave does not re-check token or amount; its swap endpoint also ignores the minimum output. Norr checks every result afterwards and pauses the vault on a mismatch. Funds can still be lost to a dishonest or compromised gateway, up to what your limits allow.
- **Phala's key service** releases the VM's encrypted settings and is a second trust assumption.
- **Every swap needs your approval** in OutLayer, because swaps and withdrawals share one transaction type there.
- **Confidential swaps have no independent audit trail.** They are checked from balances and the provider's own report, and labelled `custody-reported`.
- **Funding and withdrawals are public**, and the custody provider and NEAR Intents operator see confidential trades. A funding transfer and the next hop can be correlated by timing and amount.
- **One vault per deployment, set up by the operator.** There is no self-serve vault creation yet.
- **Owning a vault needs a NEAR account.** EVM and Solana users can fund a vault but not sign in or approve swaps.
- **The Shield incident feed needs a key.** Without it the hosted service blocks every trade (it fails closed).
- **Limit orders are out of v1**: two test limit orders never filled.
- **Stock minimums move** with the market and the time of day.
- **Stock eligibility** follows third-party sources; this is not legal advice and has not been reviewed by counsel.
- **Scam Shield is heuristics**, not a guarantee; it blocks some legitimate tokens it cannot score.
- **Not audited**; small balances; the hosted service runs on demand.

## Roadmap

Researched, not built:

- **Owning a vault from an EVM or Solana wallet.** Needs an owner identity that is not a NEAR account and a way to approve custody requests.
- **Self-serve vaults.** Create a custody wallet and link it from the dashboard.
- **Norr as a NEAR Intents solver** for orders under $5; gated by KYC/KYB of an operating entity.
- **Order pooling** for $1 to $5 stock orders; changes the custody model and needs legal review.
- **Smaller stock minimums** if NEAR Intents or the issuers make the floor configurable.

Details and evidence for each item are in the repository's `docs/` folder.
