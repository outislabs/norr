# Limitations and roadmap

## Known limitations

- **Custody trust.** For swaps, OutLayer's gateway builds the route and the deposit address, and its enclave does not re-check token or amount; its swap endpoint also ignores the minimum output. Norr checks every result afterwards and pauses the vault on a mismatch. Funds can still be lost to a dishonest or compromised gateway, up to what your limits allow.
- **Phala's key service** releases the VM's encrypted settings and is a second trust assumption.
- **Every swap needs your approval** (in Norr's Approvals tab or OutLayer's dashboard), because swaps and withdrawals share one transaction type in OutLayer.
- **Confidential swaps have no independent audit trail.** They are checked from balances and the provider's own report, and labelled `custody-reported`.
- **Withdraw is new.** The owner-only Withdraw flow was built on 2026-11-10 and is proven in mock mode and was run live once on 2026-11-10 (about 1 USDC to the owner's account). The owner approved it in Norr's own Approvals tab: the hash check and the match check (including the destination) passed, and HOT Wallet signed. It has had that one real run only, so treat it as proven once, not hardened. Since 2026-11-12 the destination is read from the vault's own custody policy (the whitelisted address, or a choice if several) instead of assuming your signed-in account, and the screen says so if the policy cannot be read; that change is tested in mock mode and has not been run live yet. The approval check compares the destination too, so if the custody provider words a withdrawal differently, Approve stays disabled and you approve on the provider's own screen instead. Finished withdrawals are listed in Activity from memory, so a service restart clears the list (the money and the provider's record are unaffected).
- **Deposits and withdrawals are private: they never name your vault.** The custody provider and NEAR Intents operator see confidential trades, and the direct NEAR deposit fallback is public. What stays visible is in the [privacy model](/docs/privacy/).
- **Open beta.** Anyone can create a vault on the hosted service, up to $100 each and one per NEAR account; the operator can close new signups at any time (existing vaults keep working). The `npx @norrfi/mcp` bridge does not forward the connect-time instructions yet (direct HTTP does), so an agent connected that way should call `about_norr`.
- **Public beta limits.** Up to $100 per vault and one vault per NEAR account. Creating a vault costs about 0.02 to 0.04 NEAR of on-chain storage for its custody policy (refundable). The custody provider's free tier allows 100 operations per wallet per day.
- **Self-serve vaults are new.** The first live one was created on 2026-11-05; funding and trading in a self-serve vault are not yet run live.
- **The Claude app connector (OAuth)** is tested against Norr's own OAuth client, not yet from the Claude app itself.
- **Funding from other chains is quoted, not yet proven.** USDC on NEAR is proven on mainnet; the other chains were quoted live but not run with real funds.
- **Owning a vault needs a NEAR account.** EVM and Solana users can fund a vault but not sign in or approve swaps.
- **NEAR Intents incident feed: optional integration, not enabled yet.** It needs a NEAR Intents partner key, which this deployment does not have, so the hosted service does not check it; every other check runs (your rules, Scam Shield, eligibility, price sanity, post-trade verification). With a key it is checked last and fails closed. Agents read this in `about_norr`; the dashboard shows it as one small item in the status bar.
- **Limit orders are out of v1**: two test limit orders never filled.
- **Stock minimums move** with the market and the time of day.
- **Stock eligibility** follows third-party sources; this is not legal advice and has not been reviewed by counsel.
- **Scam Shield is heuristics**, not a guarantee; it blocks some legitimate tokens it cannot score.
- **Not audited**; small balances; the hosted service runs on demand.

## Roadmap

Planned, not built:

- **Multi-vault and client management.** Several vaults per owner (one per agent or strategy), and an operator view for people who run vaults for clients, with each client's data still sealed to that client.
- **Public route for long-tail tokens (optional).** Tokens NEAR Intents does not route could be offered through a clearly labelled public (not private) route, for owners who opt in. Today Norr refuses them with a safety report.
- **TypeScript SDK.** A typed client for the [agent API](/docs/api/), generated from the OpenAPI spec, for agents that do not use MCP.
- **Verified P&L and Follow.** P&L that others can check, each trade backed by evidence, so an owner can publish a track record without revealing positions in real time, and others can follow it.

Researched, not built:

- **Owning a vault from an EVM or Solana wallet.** Needs an owner identity that is not a NEAR account and a way to approve custody requests.
- **Norr as a NEAR Intents solver** for orders under $5; gated by KYC/KYB of an operating entity.
- **Order pooling** for $1 to $5 stock orders; changes the custody model and needs legal review.
- **Smaller stock minimums** if NEAR Intents or the issuers make the floor configurable.

Details and evidence for each item are in the repository's `docs/` folder.
