# Self-serve Norr (public beta): design

Status: proposed 2026-11-04, building. Target: done by Nov 11.

Today Norr runs one vault, configured by environment variables, with one agent token printed at boot. This design lets
any NEAR account holder create their own vault in the dashboard, set its custody policy with their own wallet, connect
an agent (token or OAuth), and trade, without anyone at Norr doing anything.

## What OutLayer allows (checked 2026-11-04)

From the API spec (`api.outlayer.ai/openapi.json`) and the contract source (`out-layer/outlayer`, `contract/src/wallet.rs`):

| Need | OutLayer | Consequence for Norr |
|---|---|---|
| Create a wallet | `POST /register` with `{}` returns `wallet_id`, `api_key` (shown once), `near_account_id`. 30 requests per minute per IP. | Norr registers one wallet per vault and seals the key in the enclave. |
| Who controls the policy | The policy lives on chain (`outlayer.near`). **The first account to call `store_wallet_policy` becomes the wallet's controller for good**; only it can update, freeze or unfreeze ("Only the original controller can update this wallet policy"). | The **owner's** wallet sends that call, so the owner, not Norr, controls the policy. Norr's API key can never change it afterwards. |
| Signing the policy | `POST /wallet/v1/encrypt-policy` (keystore encrypts), then `POST /wallet/v1/sign-policy` with `caller`: the keystore signs a message naming the caller, valid for that account only. | Norr prepares the payload for `caller = owner`; the owner's wallet submits it. Policy setup happens inside Norr, with no handoff to OutLayer's site. |
| Cost | Storage deposit at 10^19 yoctoNEAR per byte: about 0.02 to 0.04 NEAR (the demo wallet's policy: 0.0309 NEAR). Refunded to the owner when the policy shrinks or is deleted. | Paid by the owner, once. |
| Verify the controller | View method `get_wallet_policy(wallet_pubkey)` returns `owner` (the controller), `frozen`, the encrypted blob. (The REST `GET /wallet/v1/policy` reports the wallet key as "controller", which is not the on-chain owner.) | Norr and the browser both read the chain directly before a vault is activated. |
| Approvals | Approvers by NEAR account; NEP-413 votes from any full-access key; `role: admin` may also modify policy and freeze. | Each vault's owner is its single admin approver; the in-dashboard Approve/Reject already works for any owner. |
| Autonomy | `approval.excluded_types` per request type; `confidential` covers swap, transfer, withdraw, unshield. The whitelist still binds transfers (tested: 403 for a non-whitelisted account). | Autonomous mode is a per-vault owner choice, off by default, with tight limits. |
| Before a policy exists | A wallet with no policy is unrestricted. | A vault cannot be funded or traded until its policy is on chain and checked (status `setup` until then). |
| Usage | Free tier: 100 custody operations per wallet per day. | Per wallet, so it scales with vaults; shown in Limitations. |

Trust note, unchanged: OutLayer's gateway builds swap routes and its TEE does not re-check token or amount; Norr checks
every swap afterwards. During the short window between registration and the owner's policy, Norr's service holds a key to
an empty, unrestricted wallet; the attested code never funds or uses it before activation.

## The flow

1. **Sign in** (NEAR wallet, NEP-413, as today). A signed-in account with no vault sees an empty state: what Norr is, the
   beta limits, and "Create a vault".
2. **Create** (`POST /owner/v1/vaults`): the owner accepts the beta terms and risk disclosure (versioned; the version and
   time are stored with the vault) and may confirm non-US status (needed for stocks; can be done later). Norr checks the
   operator switch, the per-owner limit (one vault per account in the beta), the beta-wide limit and rate limits, then
   registers an OutLayer wallet and seals its key. Status: `setup`.
3. **Custody policy** (`POST /owner/v1/vaults/:id/custody-policy`): Norr builds the safe default (below), shows it in
   plain words and as JSON, and returns the encrypted, keystore-signed payload for the owner's account. The dashboard asks
   the owner's wallet to send `store_wallet_policy` to `outlayer.near` with the storage deposit. The owner can tick
   "Autonomous mode" here (off by default; turning it on needs a second, explicit confirmation that the service also
   requires), which adds `excluded_types: ["confidential"]` and nothing else. The owner can switch it later in Rules:
   the same policy with only that exemption changed, one signature (an update by the controller), verified like
   activation before the new mode is reported.
4. **Activate** (`POST /owner/v1/vaults/:id/activate`): Norr reads `get_wallet_policy` on chain (controller must be the
   owner, not frozen) and the keystore's decrypted policy (it must be the one Norr prepared: approver, whitelist,
   types, limits). Only then the vault becomes `active`: funding, agent tokens and trading open.
5. **Fund** (Fund tab, as today), capped: a funding address is refused if the vault's value plus the amount would pass
   the beta deposit cap ($100).
6. **Connect an agent**: a token (as today, now kept across restarts) or OAuth (below). Approvals, rules, activity,
   kill switch: as today, per vault.

### The default custody policy (generated per vault)

- `transaction_types: ["confidential"]`, capability `confidential` only (`evm_sign`, `solana_sign` off; everything else
  default-deny under a policy).
- `addresses`: whitelist of the owner's account and the vault's own account. Nothing can be sent anywhere else.
- `approval`: threshold 1, approver = the owner with role `admin`. No exclusions unless the owner chose autonomous mode.
- `allowed_tokens` and `limits`: USDC plus the assets Norr's rules allow, per transaction at the vault's max trade and
  per day at its daily cap (Norr's defaults: $10 and $30), converted to token units at the price of the day with 25%
  headroom for price moves (Norr's own caps are exact in USD and run first).
- `rate_limit: 10 per hour`.

## Isolation (multi-tenant)

- **Per-vault records**, each encrypted with the service data key and bound to the vault id (AES-GCM with the vault id
  as associated data, so a record cannot be moved to another vault): vault directory entry, sealed custody key, agent
  token hashes, state (rules, caps, book), ledger.
- **Owner API**: every vault route resolves the vault through the signed-in owner; another owner's vault answers 404,
  never 403 (no existence oracle). A test walks every owner route with another owner's session.
- **Agent API**: a token (or OAuth access token) maps to exactly one vault; agent routes take no vault id.
- **Keys** never leave the enclave and are never returned by any route; the custody client is built per vault from its
  sealed key.

## Agent OAuth (for the Claude app and other connector clients)

MCP authorization (spec 2025-06-18): `mcp.norr.finance` is the resource server, `api.norr.finance` the authorization
server.

- `GET /.well-known/oauth-protected-resource` on the MCP host; a 401 carries `WWW-Authenticate: Bearer resource_metadata=…`.
- `GET /.well-known/oauth-authorization-server` on the API host; dynamic client registration (`POST /oauth/register`,
  public clients, https or loopback redirect URIs), authorization code with PKCE S256 only.
- `/oauth/authorize` sends the owner to the dashboard (`app.norr.finance/authorize`), where they sign in, see the client's
  name and redirect host, pick **one** vault, and approve. The access token is a Norr agent token for that vault (same
  scope as a pasted token: read, quote, trade; never withdraw or change rules), with a refresh token. Every grant is listed
  under the vault's Connect tab and can be revoked there.
- Plain bearer tokens keep working for every other client.

## Public-beta safeguards

| Safeguard | How |
|---|---|
| Deposit cap | $100 per vault by default (`NORR_BETA_DEPOSIT_CAP_USD`); funding addresses past it are refused; buys are refused while the vault holds more than the cap. |
| Terms and risk disclosure | Versioned text at `norr.finance/docs/terms`; acceptance (version, time, account) stored with the vault; creation fails without it. |
| Stocks | Unchanged: blocked (`INELIGIBLE`) until the owner confirms non-US status for that vault. |
| Rate limits | Per owner account (vault creation, owner API), per agent token (trades, reads), per IP for OAuth endpoints; 429 with a plain reason. |
| Operator switch | `NORR_SIGNUPS=open|closed` at boot, changeable at run time through the admin endpoint; when closed, existing vaults keep working and the dashboard says new vaults are paused. Public: `GET /v1/beta`. |
| Limits on growth | One vault per account; a beta-wide vault limit (`NORR_BETA_MAX_VAULTS`). |

## Not in this beta

- Owners without a NEAR account (EVM/Solana sign-in): unchanged limitation.
- Closing a vault from the dashboard (the owner can withdraw to their whitelisted account through OutLayer).
- Changing the custody policy from Norr after activation (the owner can, as controller, in OutLayer's dashboard; Norr
  re-checks it before each trade window).

## Build order

1. Vault directory, sealed custody keys, persisted token hashes, isolation tests.
2. OutLayer client: register, encrypt/sign policy, on-chain policy read; policy builder (pure, tested); onboarding routes; mock mode end to end.
3. Dashboard: empty state, create (terms), policy review and signing, activation, capped funding.
4. Safeguards: cap, rate limits, operator switch, `/v1/beta`.
5. OAuth on the MCP host and the dashboard consent screen.
6. Docs, README, llms.txt, Limitations; live test with a fresh vault (owner pays ~0.03 NEAR storage).
