# What is private, from whom (honest draft)

Status as of 2026-11-02 (first drafted 2026-10-30). "Built" means it exists in the repo and is tested; "Planned" means it does not exist yet. This table is the source for the README's privacy section; do not claim a row marked Planned or "Not private".

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
| Agent's stated reasoning (`reason`) | **The owner only.** Sealed to a key derived in the owner's browser from one wallet signature (X25519 + AES-GCM). The service writes it but cannot read it back; the API returns only the sealed box. Until the owner has enrolled a key it is held sealed to the service's data key, then moved to the owner's key at enrollment | Same | Built |
| Activity log and decisions | The service (it must read decisions to enforce caps and answer the agent). Encrypted on disk with the service data key, so copying the files alone reveals nothing. **The operator holds that key** (`NORR_DATA_KEY`), so the operator, given a copy of the files, could decrypt them | Data key derived inside the enclave, so the operator cannot (proposed: `docs/OPERATOR-PRIVACY.md`) | Encrypted at rest: Built. Operator-proof key: **Planned, not built** |
| Per-vault counters, positions, policy and kill switch | The service. Same encrypted file layer (`data/vaults/<id>.json`); the agent sees a planning view only | Same, with the service running in a TEE | Encrypted at rest: Built. TEE: Planned |
| Agent tokens | Only SHA-256 hashes are stored | Same | Built |
| API keys for custody | The service's environment. On the Phala deployment they are encrypted environment variables that only the CVM can decrypt (Phala's key service is a trust assumption) | Same | Built (deployed 2026-11-02) |
| Strategy / prompts in the agent | The agent's host (Claude Desktop, IronClaw or other) | Agent hosted in a TEE | Not Norr's to promise; IronClaw unverified |
| Service code integrity | Anyone: the public `/attestation` and `/info` endpoints return a TDX quote bound to the caller's nonce, the measured configuration and the pinned image digests; the Verify screen and `scripts/verify-attestation.mts` check them (seven checks, including a production-OS-image check and the quote's signature chain, which the dashboard verifies in the browser against Intel's root certificate since 2026-11-03). It proves which code and images booted, not what secrets were given | Same | **Built and checked against our own CVM on 2026-11-02** |

### Who can read what, today (the operator's position)

| | Reads Norr's stored data | Reads your sealed reasoning | Moves money |
|---|---|---|---|
| The Norr service, inside the enclave | Yes, in plaintext, to enforce the rules and answer the agent | Never after sealing (it seals to your key at once) | Only through the custody provider, inside your policy |
| The operator (the person who runs Norr) | **Could**, with a copy of the data and the key they hold; there is no ordinary way to reach the files (no shell in the production image, private logs). **Could** also deploy changed code, which attestation shows but does not prevent | No | Only as your custody policy allows: your whitelisted account, your approval unless you chose autonomous mode |
| OutLayer (custody provider) | Sees every custody operation it builds and signs | No | Holds the wallet keys in its TEE; limits and approvals bind it |
| NEAR Intents operator and solvers | See confidential intents in plaintext | No | No |
| Anyone else | No | No | No |

Moving the data key into the enclave, so the operator cannot decrypt a copy, is proposed in `docs/OPERATOR-PRIVACY.md` and is not built. Even then the operator could ship new code under the same app; only on-chain governance of allowed code versions closes that.

### How the private reasoning works, and what it does not protect
- The owner's key is derived from a wallet signature over a fixed message (ed25519 signatures are deterministic, so it is the same every time). The private half never leaves the browser; only the public half is sent to the service.
- Unlocking asks the wallet for one signature: no transaction, no fee. The derived secret is kept for the tab's session so a reload does not prompt again, and it is cleared on logout.
- **Limits, stated plainly:**
  - The service chooses what to seal to: the public key the owner enrolled. A compromised service could swap that key for its own and read *future* reasoning. This is the same trust as running the service at all until it runs in an attested enclave.
  - Anyone who can get you to sign the same fixed message (a phishing page) could derive the same key; they would still need the sealed data, which only the service holds.
  - If your wallet ever produces a different signature (different key or wallet), older entries cannot be opened from it. The dashboard says so and offers a new key for new entries.
  - The data key is the layer for everything else. Without `NORR_DATA_KEY` a development key is created in the data directory, which protects against copying the data files alone, not against someone who can read that directory. In production it comes from the enclave's sealed secrets.
  - The decisions themselves (assets, amounts, outcomes) are readable by the service and, through `get_activity`, by the agent that made them.
  - Losing the data key makes the files unreadable by design: the service refuses to start rather than start empty.

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

## Safety checks that are not running

- **The NEAR Intents incident feed (Shield)** is not configured on the hosted service: the partner key has not been granted. It is a deployment setting, not a hidden bypass: `/health`, `get_policy`, every quote and trade result, and the dashboard (status bar and Verify) say "Incident feed: not configured (partner key pending)". All other checks run. When a key is set, the feed is checked for every trade that passes the rules and fails closed.

## Lookups to third parties

To score a token, the Norr service asks DexScreener and GoPlus Security about it (read-only, no key, cached 10 minutes for GoPlus and 1 minute for DexScreener). Those services learn which token addresses are being checked, from the service's address, not which vault or agent asked or whether a trade followed.

## What cannot honestly be claimed
- That a trade is hidden from OutLayer, Defuse or the private-chain operator.
- That confidential trades are independently verified: the audit trail for them rests on the custody provider's reports, because the independent check needs a user session that only the wallet's key can create.
- That the owner's funds cannot be seen being deposited or withdrawn on the public chain.
