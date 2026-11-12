# What is private, from whom (honest draft)

Status as of 2026-11-12 (first drafted 2026-10-30). "Built" means it exists in the repo and is tested; "Planned" means it does not exist yet. This table is the source for the README's privacy section; do not claim a row marked Planned or "Not private".

## Trading privacy (NEAR Intents)

| Information | Public chain observers | OutLayer (custody gateway) | NEAR Intents operator / solvers (Defuse, 1Click) | Norr service | Status |
|---|---|---|---|---|---|
| A normal (public-Intents) swap: pair, amount, vault account | Visible | Sees all | Sees all | Sees all | Built (public path) |
| A **confidential** swap, inside the confidential layer: pair, amount, price, balance | **Hidden, confirmed on mainnet for a 1.5 USDC to SOL swap**: the public Intents balance did not move and no public transaction was listed (private "FAR" chain, no public RPC) | Sees all (it builds and signs the artifact) | **Sees plaintext intents**; the operator can read FAR state, as can auditors or law enforcement with a warrant | Sees all | Swap tested; hidden from the public side |
| Shielding / unshielding between public and confidential | **Visible, confirmed on mainnet**: a public `execute_intents` call on `intents.near` showing the vault's account, the token, the amount and the time | Sees all | Sees all | Sees all | Shield tested (1.5 USDC); unshield pending |
| Deposits (through Norr's 1Click quote) and confidential withdrawals | **Private: they never name the vault.** Traced on mainnet (2026-10-30 and 2026-11-10): a deposit shows the owner's wallet paying a one-time address that forwards into NEAR Intents; a withdrawal shows NEAR Intents (through intermediate accounts) paying the owner's wallet. Amount and time are visible on the owner's wallet side | Sees both | Sees both | Sees both | Deposit (USDC on NEAR) and withdraw tested |
| That a vault exists, and which account it is | **Tied to the owner's account on chain** by the custody policy the owner stores (`get_wallet_policies_by_owner` on `outlayer.near` lists the vault's key). Its confidential balance and trades are not | n/a | n/a | n/a | Observed 2026-11-12 |
| Direct NEAR deposit (fallback when 1Click cannot quote) | **Public**: it sends straight to the vault's account; the later move into the confidential layer is also public | Sees all | Sees all | Sees all | Built, not run live |
| That the traffic comes from Norr | n/a | Yes | Yes (the partner API key and `partner_id` identify Norr) | n/a | Not private |

### Deposits and withdrawals: who sees what

Deposits and withdrawals are private: they never name your vault. In detail:

- **What an observer sees.** For a deposit, your own wallet sending an amount to a one-time address, which forwards it into NEAR Intents. For a withdrawal, NEAR Intents paying an amount to your own wallet. The amounts and times are visible on your wallet's side, so a deposit and a later withdrawal of similar size and timing can be matched to each other.
- **What an observer does not see.** Which vault the money went into or came out of: the vault's account appears in none of these transactions (traced in `docs/FINDINGS.md`, "Deposits and withdrawals on chain"). 1Click's status for the one-time address is not public (404 without a key).
- **The vault's existence is tied to your account.** The custody policy you store on chain from your NEAR account (it is what keeps Norr from changing your limits) lists the vault's key, which is the vault's account. So anyone looking up your account can learn that you have a vault and which one; they cannot see its confidential balance or trades.
- **Who sees the trades.** The custody provider (OutLayer) and NEAR Intents' operator and solvers see trades in order to execute them, and the Norr service sees them to enforce your rules.
- **The direct NEAR deposit fallback is public.** When 1Click cannot quote, the Fund tab can send USDC straight to the vault's account on NEAR Intents: sender, vault and amount are visible, and so is the move into the confidential layer.
- **Tested so far:** deposits of USDC on NEAR and confidential withdrawals to the owner. Deposits from other chains go through 1Click the same way but have not been run with real funds.

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

## Withdrawing (owner-only, built 2026-11-10)

The owner's Withdraw flow takes funds out of the vault's confidential balance to the owner's own account. What becomes public: the arrival on NEAR (the amount, the receiving account and the time). Do not assume the confidential layer hides the link between the vault and that arrival; what stays private is the vault's other holdings and trades and the agent's reasoning. The destination is never taken from a request: it is the vault's owner, the whitelist account. Norr refuses to start a withdrawal while the vault is autonomous, because OutLayer uses one `confidential` type for swaps and withdrawals and would run it without the owner's signature. A dry run moves nothing. Run live once on 2026-11-10 (about 1 USDC to the owner).

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

What this shows: the vault never holds the money publicly, and the vault's account never appears in the funding transaction. The 2026-11-10 trace (`docs/FINDINGS.md`) followed the next hops too: the one-time address forwards into NEAR Intents and on to the confidential layer's entry account, and the vault is not named there either. What it does not show: that the owner and the vault cannot be linked. They are, through the custody policy on chain (above), and the funding amount and time are visible on the owner's side. The design's advice for the exit (a different owner account, a time gap, no round amounts) applies to funding too.

## Verification limits (observed)
After a shield, 1Click's status endpoint returned 404 for the deposit address. The only independent evidence of a confidential step is on the public side (the public balance falls, the public transaction is visible); the confidential balance and the result of confidential swaps come from OutLayer.

## Optional safety checks that are not enabled

- **NEAR Intents incident feed: optional integration, not enabled yet** It is a deployment setting, not a hidden bypass: `about_norr` and the dashboard's status bar state it. All other checks run. When a partner key is set, the feed is checked last, for every trade that passes the rules, and fails closed.

## Lookups to third parties

To score a token, the Norr service asks DexScreener and GoPlus Security about it (read-only, no key, cached 10 minutes for GoPlus and 1 minute for DexScreener). Those services learn which token addresses are being checked, from the service's address, not which vault or agent asked or whether a trade followed.

## What cannot honestly be claimed
- That a trade is hidden from OutLayer, Defuse or the private-chain operator.
- That confidential trades are independently verified: the audit trail for them rests on the custody provider's reports, because the independent check needs a user session that only the wallet's key can create.
- That the owner's funds cannot be seen being deposited or withdrawn on the public chain: the owner's own transfers, their amounts and times are visible. What is private is which vault they belong to.
- That nobody can tell the owner has a vault: the custody policy on chain ties the vault's account to the owner's.
