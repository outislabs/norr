# What is private, from whom (honest draft)

Status as of 2026-10-30. "Built" means it exists in the repo and is tested; "Planned" means it does not exist yet. This table is the source for the README's privacy section; do not claim a row marked Planned or "Not private".

## Trading privacy (NEAR Intents)

| Information | Public chain observers | OutLayer (custody gateway) | NEAR Intents operator / solvers (Defuse, 1Click) | Norr service | Status |
|---|---|---|---|---|---|
| A normal (public-Intents) swap: pair, amount, vault account | Visible | Sees all | Sees all | Sees all | Built (public path) |
| A **confidential** swap, inside the confidential layer: pair, amount, price, balance | **Hidden, confirmed on mainnet for a 1.5 USDC to SOL swap**: the public Intents balance did not move and no public transaction was listed (private "FAR" chain, no public RPC) | Sees all (it builds and signs the artifact) | **Sees plaintext intents**; the operator can read FAR state, as can auditors or law enforcement with a warrant | Sees all | Swap tested; hidden from the public side |
| Shielding / unshielding between public and confidential | **Visible, confirmed on mainnet**: a public `execute_intents` call on `intents.near` showing the vault's account, the token, the amount and the time | Sees all | Sees all | Sees all | Shield tested (1.5 USDC); unshield pending |
| Link between a deposit and a later withdrawal | **Withdrawal tested on mainnet**: the two public transactions show intermediate accounts paying the owner, and the vault's own account does not appear in either. Per NEAR Intents' docs a deposit and a later withdrawal cannot be tracked to each other, but can still be correlated by timing and amount. Not yet tested end to end with a confidential deposit | Sees both | Sees both | Sees both | Withdraw tested; confidential funding pending |
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

## Planned design for the final demo vault: confidential in, confidential out
The first confidential spike only proves the mechanics (shield, confidential swap) on an old wallet. The stronger design keeps the public chain from ever seeing the vault hold or move the money:

1. **Use a fresh OutLayer wallet** for the demo vault (registration is free and off-chain). The test wallet already has public history: a public deposit from the owner's account and a public withdrawal back, which are linked.
2. **Fund it directly into the confidential layer** (`POST /wallet/v1/confidential/deposit/cross-chain`, request body not yet documented): the owner sends USDC to a per-request deposit address, and the funds arrive in the confidential balance, so the vault's account never holds them publicly. A dry quote for this route priced it at 0.000% (a same-asset route).
3. **Trade inside the layer.** Norr must quote with `CONFIDENTIAL_INTENTS` deposit, recipient and refund types and `confidentiality: basic`, and its custody adapter needs confidential swap, balance and withdraw calls. Equities are quotable confidentially (a $30 NVDAon quote cost 0.343%); execution is untested.
4. **Withdraw from the layer** (`confidential/withdraw`, approval-gated, destination on the whitelist). Per NEAR Intents' docs a deposit and a later withdrawal then cannot be tracked to each other, but timing and amount can still correlate, so: withdraw to a different owner account than the one that funded it where possible, leave a time gap, avoid round amounts. A dry quote for the withdraw route also priced at 0.000%.

Needs: the `confidential` type and capability in the vault's OutLayer policy (and possibly more entries that only the live calls reveal, as with deposits earlier); the new Norr adapter code; the dashboard showing the confidential deposit address; a decision on autonomy (see below).

Open risks:
- Shield, confidential swap and confidential withdraw all appear to share the one `confidential` transaction type, so exempting swaps from approval for autonomous mode might also exempt withdrawals. Before the demo this must be tested; otherwise keep approvals on, or rely on the pinned whitelist destination and low limits.
- Confidential trades cannot be verified independently of OutLayer (see above).
- OutLayer, Defuse and the private-chain operator still see everything.

## Observed on mainnet (2026-10-30, 1.5 USDC test)
| Step | Public footprint seen |
|---|---|
| Shield 1.5 USDC | One public `execute_intents` on `intents.near`: the vault's account, USDC, 1500000, deadlines and signatures |
| Confidential swap USDC to SOL, and back | None found: the public Intents balance did not move; no NEAR transaction hash listed |
| Confidential withdraw 1 USDC to the owner | Two public `execute_intents`: an intermediate account pays another intermediate account, which withdraws 1 USDC to the owner's account. The vault's account is not named |

## Observed on mainnet (2026-10-30, demo vault, 8 USDC in, $6 NVDAon round trip)
This is the "confidential in" design above, run on a fresh OutLayer wallet. What I checked on the public chain, and what I did not:

| Step | Public footprint seen |
|---|---|
| Fund: 8 USDC to the per-request confidential deposit address | One plain NEP-141 `ft_transfer` from the owner's account to a hex deposit address (owner account, address and amount visible). The vault's account is not named in it. Afterwards the deposit address holds 0 USDC, so the funds were moved on; I did not trace that second movement |
| Buy $6 NVDAon, then sell it all back (confidential) | None found where I looked: the vault's public Intents account held no tokens at any point I checked, so nothing was ever held publicly. I did not search the chain for other traces of the swaps (solver legs, relayer transactions), so "none found" means "not looked for beyond the vault's own balances" |

What this shows: the vault never holds the money publicly, and the vault's account never appears in the funding transaction. What it does not show: that the owner and the vault cannot be linked. The funding transfer is a public transaction from the owner, with the amount, to an address Norr then routes into the vault's confidential balance, so a watcher who also sees the next hop could connect them. The design's advice for the exit (a different owner account, a time gap, no round amounts) applies to funding too.

## Verification limits (observed)
After a shield, 1Click's status endpoint returned 404 for the deposit address. The only independent evidence of a confidential step is on the public side (the public balance falls, the public transaction is visible); the confidential balance and the result of confidential swaps come from OutLayer.

## What cannot honestly be claimed
- That a trade is hidden from OutLayer, Defuse or the private-chain operator.
- That confidential trades are independently verified: the audit trail for them rests on the custody provider's reports, because the independent check needs a user session that only the wallet's key can create.
- That the owner's funds cannot be seen being deposited or withdrawn on the public chain.
