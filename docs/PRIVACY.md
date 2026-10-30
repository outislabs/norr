# What is private, from whom (honest draft)

Status as of 2026-10-30. "Built" means it exists in the repo and is tested; "Planned" means it does not exist yet. This table is the source for the README's privacy section; do not claim a row marked Planned or "Not private".

## Trading privacy (NEAR Intents)

| Information | Public chain observers | OutLayer (custody gateway) | NEAR Intents operator / solvers (Defuse, 1Click) | Norr service | Status |
|---|---|---|---|---|---|
| A normal (public-Intents) swap: pair, amount, vault account | Visible | Sees all | Sees all | Sees all | Built (public path) |
| A **confidential** swap, inside the confidential layer: pair, amount, price, balance | **Hidden** (private "FAR" chain, no public RPC) | Sees all (it builds and signs the artifact) | **Sees plaintext intents**; the operator can read FAR state, as can auditors or law enforcement with a warrant | Sees all | Spike pending |
| Shielding / unshielding between public and confidential | **Visible**: the vault's account, token, amount, time | Sees all | Sees all | Sees all | Spike pending |
| Link between a deposit and a later withdrawal | Hidden if funds were deposited into, traded in and withdrawn from the confidential layer (per NEAR Intents' docs: "deposits and withdrawals cannot be tracked to each other"); can still be correlated by timing and amount | Sees both | Sees both | Sees both | Spike pending |
| That the traffic comes from Norr | n/a | Yes | Yes (the partner API key and `partner_id` identify Norr) | n/a | Not private |

Notes from NEAR Intents' documentation (and OutLayer's): a vault's confidential identity is the custody wallet itself, so there is no separate unlinkable identity; the private layer is a permissioned chain run by a small validator set; its protection is against the public, not against the operator.

## Norr's own data

| Data | Who can read it today | Target | Status |
|---|---|---|---|
| Agent's stated reasoning (`reason`) | Held in the service's memory ledger in plaintext; never returned to agents; never logged | Encrypted to the vault owner's key so only the owner can read it, even from the service's storage | Plaintext in memory; encryption Planned |
| Activity log and decisions | The service's memory | Same | Planned |
| Per-vault Norr policy | The service; the agent sees a planning view only | Same, with the service running in a TEE | Built (agent view); TEE Planned |
| Agent tokens | Only SHA-256 hashes are stored | Same | Built |
| API keys for custody | The service's environment | Sealed by the TEE | Planned |
| Strategy / prompts in the agent | The agent's host (Claude Desktop, IronClaw or other) | Agent hosted in a TEE | Not Norr's to promise; IronClaw unverified |
| Service code integrity | Nothing to verify yet | TEE attestation of the exact code, shown on the Verify screen | Planned |

## What cannot honestly be claimed
- That a trade is hidden from OutLayer, Defuse or the private-chain operator.
- That confidential trades are independently verified: the audit trail for them rests on the custody provider's reports, because the independent check needs a user session that only the wallet's key can create.
- That the owner's funds cannot be seen being deposited or withdrawn on the public chain.
