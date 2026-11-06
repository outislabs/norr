# Keeping the operator out of users' data (proposal, not built)

Status: proposed 2026-11-06 for Kelvin's decision. Nothing here is built. The current-state statements in `docs/PRIVACY.md`
and `about_norr` were corrected the same day; this document is only about changing the key.

## Today

Norr's stored data (vault state, ledgers, self-serve vault records, agent-token hashes, OAuth state, and each
self-serve vault's custody API key) is encrypted on the CVM's volume with AES-GCM under `NORR_DATA_KEY`, with the vault id
as associated data. **The operator generates that key** (`openssl rand`, `docs/FIRST-DEPLOY.md`), keeps it in
`deploy/.env.phala` and an offline copy, and passes it to the CVM as an encrypted environment variable. So:

- Someone with a copy of the volume (the host, a snapshot, a backup) **and** the operator's key can read all of it,
  including every self-serve vault's custody API key. The production image has no shell and logs are private, so the
  operator has no ordinary way to reach the files; the point is that the key, not the lack of access, is what protects them.
- The operator can deploy a changed image. Every version is visible through attestation (the compose hash and image
  digests are in the quote), but visible is not prevented: a changed image reads decrypted state inside the enclave.
- The owner's reasoning is **not** affected: it is sealed to the owner's key, which never leaves their browser.
- Even holding a vault's custody key, the operator is bound by that vault's custody policy: destinations are the owner's
  whitelisted account only, and swaps wait for the owner's approval unless the owner chose autonomous mode.

## What this CVM uses (confirmed with `phala cvms get norr-demo --json`, 2026-11-06)

`kms_type: phala`: Phala's own KMS (`kms.dstack-pha-prod7.phala.network`), **not** on-chain KMS (no chain ID, no DstackApp contract, no deployer address). App id `85e1d6a5…`, created by the Phala Cloud account `outislabs`, private logs, production OS image. So the app's creator updates the code with a Phala Cloud login (no on-chain step), and the key service that would hold the derived key is Phala's, which this project already trusts for the encrypted environment variables. On-chain KMS is chosen when an app is created, so moving to it later means a new app, which is the same event as the "recreate the CVM" risk below.

## What dstack offers (checked against Phala's docs, 2026-11-06)

`DstackClient.getKey(path)` (socket `/var/run/dstack.sock`, already mounted) returns 32 bytes derived from the
application's root key inside the TEE. The same path always gives the same key; only `path` takes part in the derivation.
Keys are "tied to app ID": other apps cannot derive them. **They are tied to the app id, not the compose hash**, and stay
the same across compose updates. When the app's owner is a plain wallet, one command (`phala deploy --cvm-id …`) updates
the compose; with on-chain KMS, a new compose hash must first be allowlisted on chain (`addComposeHash` on the app's
`DstackApp` contract), and the owner can be a multisig or timelock.

## Proposal

Derive the data key inside the enclave (`getKey("norr/data-key/v1")`) instead of taking it from `NORR_DATA_KEY`.

What that removes: the operator knowing the key, and with it the operator's `.env.phala`, offline copy and any backup as a
way to decrypt a copied volume. After the migration, a copy of the volume is useless without the running enclave.

What it does **not** remove, said plainly: the operator's ability to ship new code under the same app id, which then
derives the same key. That boundary is closed only by governance, not by cryptography: on-chain KMS with the app's
allowed compose hashes owned by a multisig or timelock (users can then see a change coming, on chain, before it can
run). I would do that after the hackathon; here I would only state it.

### Migration (safe, resumable, reversible until the last step)

1. **Prove the key is stable first, with no data change.** Ship a build that derives the key and exposes only its
   fingerprint (a hash of a hash) on the attested `/info`. Redeploy twice; the fingerprint must not change. This tests
   the one claim the whole plan rests on (same app id, same key, across updates) on the real CVM.
2. **Versioned envelope.** Each encrypted file records which key made it (`kid: "env-v1" | "dstack-v1"`); reads pick the
   key by `kid`. Old files still read.
3. **Re-encrypt at boot, atomically.** Back up the data directory (still under the old key) on the same volume. Then,
   per file, under the existing lock: decrypt with the old key, encrypt with the new one, write to a temporary file, read
   it back and compare, then rename. A journal records progress, so an interrupted run resumes. Any unreadable file stops
   startup, as today.
4. **Cut over.** Once the journal is complete and a restart reads everything under the new key, the operator redeploys
   without `NORR_DATA_KEY`. The service then refuses to start if any file is still under the old key, so nothing is
   silently dropped. The operator deletes the offline copy and, after a retention period, the backup.

### The real risk, and what I would do about it

The key is tied to the app id. If the CVM is ever recreated as a **new app** (a fresh deployment, not an update), the new
app derives a different key and every file is unreadable. The data is then gone by design, including each self-serve
vault's custody API key. A vault's money is not lost: the owner is the policy's controller on chain and keeps the
custody provider's own owner recovery (not yet tested by us). But Norr could no longer operate the vault until the owner
re-created it. Options:

- **A.** Accept it, document it, and never recreate the app (updates only). Cheapest; one mistake is expensive.
- **B.** Keep an offline recovery copy of the data key, sealed to a recovery key the operator holds. Safe against that
  mistake, but it puts an operator-held key back, which defeats the purpose.
- **C.** Make custody keys re-creatable: store only a re-registration path so an owner can re-link a wallet after a
  loss. More work, and it still needs the owner's signature.

I recommend **A for the beta**, with step 1 as the guard, and **C** as a follow-up.

## What the statements say before and after

| | Today | After the change |
|---|---|---|
| Norr service, inside the enclave | Sees requests, balances, positions, rules, ledger; sees your `reason` only until it seals it to your key | Same |
| Operator can read a copy of the stored data | **Yes**, with the key they hold | **No**; a copy needs the running enclave |
| Operator can deploy changed code that reads state | Yes (visible via attestation) | **Yes**, unchanged (visible via attestation; closed only by on-chain governance) |
| Operator can read your sealed reasoning | No | No |
| Operator can move money out | Only as the custody policy allows (owner's whitelist, owner approval unless autonomous) | Same |
| OutLayer | Sees every custody operation it builds and signs | Same |
| NEAR Intents operator and solvers | See confidential intents in plaintext | Same |

## Cost

About a day, plus the two redeploys of step 1. Question (1), which KMS and who owns the app, is answered above. What I still need is the choice among A, B or C.
