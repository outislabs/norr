# Day-1 gating findings

Checked 2026-10-24 (updated after the API key was added). All checks were read-only calls or `dry: true` quotes. **No mainnet transaction was sent.** Everything built before Nov 1 is a spike; see `docs/CARRYOVER.md`.

| # | Check | Result |
|---|---|---|
| 1 | Equities routable via 1Click | **Pass**, Ondo only, with a minimum size of about $25–28 |
| 2 | Confidential Intents | **Pass** for crypto and equities (dry quotes, with API key) |
| 3 | TEE hosting | **Resolved by recommendation below** (NEAR AI Cloud can't host our container) |
| 4 | Equity eligibility rules | **Open.** Not documented by NEAR Intents |
| 5 | 1Click API key | **Done** (key in `.env`, sent as `X-API-Key`) |

## Funded OutLayer test: summary (2026-10-30, about $3 of USDC float)

**Proved on mainnet (crypto only):**
1. **Register and custody:** a default-master wallet registers with one unauthenticated call; the API key is shown once. The agent key can only call the wallet API; policy is owner-only and lives in OutLayer's dashboard.
2. **Policy is enforced and informative.** Denials named the missing piece each time (`call` type, then `native` token, then address `intents.near`), so a deposit needed three temporary entries, now removed. Withdrawals are bound by the whitelist (dry-run to a non-whitelisted address is denied).
3. **Approval gating works:** every swap and the withdraw went `pending_approval` and executed only after the owner's NEP-413 signature.
4. **Round trip:** deposit 3.000000 USDC (via a cross-chain deposit address; ft_transfer from the owner), swap 1.5 USDC to SOL, swap all the SOL back (net cost 0.002272 USDC, 0.15%), withdraw 1.000000 USDC to the owner. The withdraw arrived exactly (+1.000000) and the wallet still holds 0 NEAR, so the quoted 0.002 NEAR withdraw fee was **not charged**; swaps and withdraws were gasless; usage counters recorded amounts without any fee. Wallet Intents balance after: 1.997728 USDC.
5. **Norr's independent check works:** 1Click's own status endpoint, queried by the gateway's deposit address, returns route and amounts, and `verifyExecution` passed both swaps against Norr's own pre-trade quotes (executed outputs were -0.028% and +0.33% of Norr's expectation).
6. **Equity quoting works through OutLayer:** `POST /intents/swap/quote` accepts the Ondo `NVDAon` asset id, even though OutLayer's token catalog omits Ondo tokens (30 USDC quoted 0.143469 NVDAon against Norr's own 1Click quote of 0.143491, 0.015% apart).

**Found and not fixed (limitations to state in the README):**
- `min_amount_out` is accepted but ignored; the executed quote uses a 1% slippage minimum (two swaps, same result). Bug report drafted in `docs/outlayer-bug-report.md`, not yet sent.
- The swap quote is taken at approval time, minutes after the request.
- Swap routing and the deposit address are built by OutLayer's gateway and are not verified by its TEE (coordinator trust). Norr's mitigation is the post-trade `verifyExecution` and the kill switch; this detects, it cannot prevent.
- Docs are partly out of date or contradictory (retired API host, policy type names, usage recording before or after execution, the withdraw `estimated_fee`). The monthly USDC limit of $5 is now nearly used (2.5 of 5 per daily/hourly counters; reset rules undocumented).

**Not proved (open):**
- **Equity execution:** only quotes were checked. A real Ondo swap through OutLayer needs the Ondo ids in `allowed_tokens`, and has not been run (first live equity trade: the $40 NVDA buy in the rehearsal, about Nov 11-12; the $28 minimum to be re-checked).
- **Confidential Intents execution** (a `confidential` capability swap); **limit orders** as an enforced minimum (docs only; needs `limit_order` capability, type and the wallet's own account in the whitelist); the **sovereign vault**; behaviour under **concurrent requests** and counter resets; what the `trial` field in the register response means.
- **Hosting:** the Norr service on Phala dstack, its attestation, and the IronClaw demo agent are all untested.
- **Autonomy:** approval is on for every operation, so the agent cannot trade unattended yet. The rehearsal needs `excluded_types` for swaps (keeping withdrawals gated), which has not been tried.
- **Privacy:** OutLayer's gateway sees every operation; the public chain sees Intents deposits and withdrawals, as in this test (no Confidential Intents were used).

**Architecture to lock for Nov 1 (proposed):** OutLayer Agent Custody for keys, signing and the hard policy backstop; the Norr service (Phala dstack) for registry, Scam Shield, Shield feed, eligibility, private policy and log, MCP, and `verifyExecution` after every swap; withdrawals approval-gated and whitelisted to the owner; small per-vault balances. Keep Phala + Shade custody as the fallback if a later test (equity execution, autonomy, limit orders) fails.

### Limit-order spike 1: $1.50 marketable buy (2026-10-30): did not fill
- **Order:** buy exactly 0.0154 SOL, limit 99.0 USDC/SOL, max spend 1.5246 USDC (an `exact_output` swap), 1Click `app_fees` 20 bps, `confidentiality: basic`, deadline 09:02:56Z. Request `6f84d549-…`, order `order_n9Yl89FFiWJrNVNzu35fb`.
- **Timeline:** requested 08:32:57Z; the owner approved around 08:41Z and the order was created and funded (1,524,600 units locked) at 08:41:14Z, with the deadline unchanged, so approval consumed 8 of the 30 minutes. It stayed `open` with zero fills in every poll until it went `expired` at 09:03:40Z.
- **Refund:** complete. `payouts.refund` COMPLETED; the wallet's Intents USDC returned to exactly 1.997728 (no loss, no fee: `estimated_refund_fee` 0). SOL stayed 0.
- **Was it marketable?** Yes, by a thin margin. A 1Click exact-output dry quote for 0.0154 SOL cost 1.51345 USDC at 08:45Z (98.28 USDC/SOL) and 1.51792 at 09:04Z (98.57), against a 1.5246 maximum. That is a 0.7% margin, or about 0.5% after the 20 bps fee at 08:45Z, narrowing to about 0.2% by 09:04Z.
- **Conclusion:** OutLayer's "a price through the market fills at once" did **not** hold for a roughly 0.5% marketable $1.50 order. Possible causes (untested): solvers do not fill resting limit orders this small or this close to the market; a margin this thin does not cover solver spread; fills are matched only when the market crosses, not at creation. Not yet separated: price margin versus size.
- **Implication for Norr:** limit orders are usable as price protection only if they fill reliably. Until a test shows that, protection stays `verifyExecution` + kill switch + small sizes, and the swap endpoint remains the executing path. A resting order is also locked capital for up to its deadline.

### Norr service build notes (2026-10-30)
- **Shield feed needs a SHIELD-type key.** `GET https://shield.chaindefuser.com/incident` returns 401 "Authorization token is required" without a key, and 401 "Invalid key_type in token payload distribution_channel" with the 1Click partner key. A key of `key_type: SHIELD` is created at partners.near-intents.org/api-keys (per the Shield Incident API docs; incident submission needs an extra grant, reading does not). Without it Norr's Shield check fails closed, which blocks every live trade by design (`SHIELD_API_KEY` in `.env.example`).
- **Market data for Scam Shield: DexScreener, no API key.** `GET https://api.dexscreener.com/tokens/v1/{chain}/{address}` returned pools with `liquidity.usd`, `marketCap`, `fdv` and `pairCreatedAt` (milliseconds); the NEAR chain is covered (a wNEAR pool on Rhea). Rate limits for this endpoint and terms of automated use are not documented in the pages I could read; responses carry `cache-control: max-age=30`, and Norr caches lookups for 60 s and treats missing data as risk. 1Click's token list carries `contractAddress` for most chains (for example near 34/34, sol 21/22, eth 28/29, base 17/18, bsc 9/10), which is what the lookup uses. Native assets without a contract (BTC, XRP and similar) are trusted via CoinGecko ids instead, not market data.
- **Balances:** `intents.near` view calls `mt_tokens_for_owner` and `mt_batch_balance_of` work for the wallet's account and are what the portfolio and equity-limit checks read. (`rpc.mainnet.near.org` still answers, but `rpc.mainnet.fastnear.com` is what the tests and tooling used.)
- **Funding by direct deposit:** per the Intents docs, `ft_transfer_call` on the token contract with `receiver_id: "intents.near"` and `msg` set to the account id (a plain string is accepted) credits that account; attached deposit 1 yoctoNEAR, 100 Tgas is enough. Not yet done for this wallet; the $0.10 test comes first.

### 1Click quoting outage observed (2026-10-30, about 11:15Z)
All dry quotes failed with HTTP 400 `Quoting for this pair is not available`, for every pair tried (USDC, wNEAR, ETH, BTC, USDT in both directions), with or without the partner API key, with the exact request shape that worked at about 08:00-09:30Z the same day, and via OutLayer's own quote route (`upstream_rejected`). `GET /v0/tokens` still answered 200. No incident was found in public search. Cause unknown: a service outage, or a Shield "under attack" pause (the Shield feed could not be read; the SHIELD key is pending). **Resolved:** quoting worked again by about 12:54Z the same day (down for at least 11:15Z to about 12:50Z, roughly 1.5 hours; cause still unknown). Consequences while it lasted: live swaps could not be tested; Norr now reports a quote fault as "Pricing is temporarily unavailable" and not as `NO_LIQUIDITY`, and the live dry-run runner (`pnpm live:trade`, no `--confirm-mainnet`) works end to end up to the quote.

### Confidential Intents probes (2026-10-30, read-only)
- OutLayer's confidential routes are enabled: `GET /wallet/v1/confidential/balance` answered (empty) and `POST /wallet/v1/confidential/swap/quote` quoted 1.5 USDC to SOL at 15466371, against Norr's own 1Click `CONFIDENTIAL_INTENTS` dry quote of 15467968 (0.01% apart). A confidential dry-run withdraw was denied with "Transaction type 'confidential' is not allowed by policy", so the policy needs the type `confidential` as well as `capabilities.confidential` (the docs listed no such type).
- 1Click dry quotes: public Intents to confidential (shield) 0.000% cost; USDC from a NEAR account straight into the confidential layer 0.000%; confidential to a NEAR account 0.000%; confidential $30 USDC to NVDAon 0.343%. `basic` and `advanced` confidentiality returned identical quotes.
- Per NEAR Intents' docs, balances and swaps live on a private chain ("FAR") with no public RPC; the operator, auditors or law enforcement with a warrant can read it, and the 1Click/Defuse solver layer sees plaintext intents. See `docs/PRIVACY.md`.

### Do trusted ops still need approval? Conflicting evidence (2026-10-30, ~13:15Z)
- **OutLayer's dashboard** now shows, under swap: "Multisig approval is not available for trusted ops. Gate with limits + capability instead."
- **OutLayer's docs** (CUSTODY.md and the agent-custody page, both fetched today) say the opposite: "Multisig covers Trusted ops too", and that swap, confidential, cross_chain_withdraw and limit_order "execute only after the approvers confirm". They also describe a per-capability `requires_approval` flag and `approval.excluded_types`, and do not reconcile them.
- **Our own history:** this morning (about 08:00-09:30Z) every swap, the withdraw and both limit orders went to `pending_approval` and ran only after the owner signed.
- **Dry runs now:** the public `intents/withdraw/dry-run` still says "Operation would require multisig approval". The `confidential/withdraw/dry-run` returns a quote-shaped answer (`amount_out`, `min_amount_out`) with no approval message at all, which fits the dashboard banner but does not prove it.
- **Unresolved.** The live policy's `approval` section is unchanged (threshold 1, approver `legalalienx.near`). The first trusted op (the 1.5 USDC shield) will show the answer: the response says `pending_approval`, or the op simply runs. If trusted ops execute immediately, the controls for swaps and confidential ops are the capability, the allowed tokens, the limits and the whitelist, plus Norr's own checks; plain withdrawals stay approval-gated. This also changes the autonomous-mode plan: it would no longer need an approval exemption for swaps.

### First confidential op: shield 1.5 USDC (2026-10-30, request `e6d343bd-…`)
- **Whitelist:** the first attempt was refused: "Address '2005d442…4046' is not in whitelist" (the wallet's own account must be listed, because a shield pays the wallet's own confidential identity). After adding it the request was accepted.
- **Approval still applies to confidential ops.** The shield went to `pending_approval` and ran after the owner signed, so the dashboard banner ("not available for trusted ops") does not match this wallet's behavior; the docs were right for confidential. (A plain swap was not retested today; this morning's swaps paused the same way.)
- **Result:** `confidential_shield`, status `success`, 1.5 USDC in and out (0 fee). Public Intents balance on-chain fell from 1.997728 to 0.497728 exactly; OutLayer reports a confidential balance of 1.5 USDC.
- **Independent verification of the confidential side is not possible.** 1Click's `/v0/status` returned 404 "Deposit address … not found" for the shield's deposit address, even though OutLayer's own result says `oneclick_status: SUCCESS`. The only independent evidence is the public side.
- **What the public chain shows:** the shield is a public `execute_intents` call on `intents.near` whose arguments are readable: the signer is the wallet's account, the intent is a `transfer` of the USDC token, amount `1500000`, to a per-request deposit address, with deadlines and signatures. So a shield reveals the wallet, token, amount and time, as predicted in `docs/PRIVACY.md`.

### First confidential swap: 1.5 USDC to SOL (2026-10-30, request `37a811a9-…`)
- **Shape:** `POST /wallet/v1/confidential/swap` takes the same body as the public swap (`token_in`, `token_out`, `amount_in`, `min_amount_out`); accepted on the first try. It paused for the owner's approval, then ran in about 10 seconds.
- **Result:** received 15738716 SOL units (0.015738716), against Norr's own confidential quote of 15792968 (-0.34%, taken about 8 minutes earlier; the executed quote is taken at approval) and Norr's minimum of 15635038 (+103,678 above it). `verifyExecution` passed, but it ran on OutLayer-reported numbers and so is not an independent audit.
- **`min_amount_out` is again not enforced:** the result records `minAmountOut: null`.
- **Privacy, observed:** the public Intents balance did not change (USDC 497728, SOL 0, read from `intents.near`) and the result lists no NEAR transaction hashes (`nearTxHashes: []`, unlike the shield, which had one). The swap left no public trace we could find; the confidential balance (OutLayer-reported) is 0.015738716 SOL and no USDC.
- **Verification limits:** 1Click's `/v0/status` does not know this deposit address either (404), so no independent audit of the confidential side exists. Cost: 0.34% from the quoted price, no explicit fee.

### Confidential swap back: all SOL to USDC (2026-10-30, request `11ef5a82-…`)
- Approved by the owner, then ran in seconds. Received 1486643 USDC units (1.486643) for 0.015738716 SOL, above Norr's own confidential quote (1481237, +0.36%) and minimum (1466424). `minAmountOut` is again recorded as null (not enforced). The public Intents balance stayed at 497728 USDC and 0 SOL (on-chain); no NEAR transaction hash was listed. `verifyConfidentialSwap` passed on the before/after balances and the provider's report (not independent).
- Round trip 1.5 USDC to SOL to USDC, all inside the confidential layer after the shield: 1.5 to 1.486643 (cost 0.89%).

## 1. Assets and multi-issuer routing
- `GET /v0/tokens` returns 205 tokens, no equities. `?ondoTokens=true` adds 28, all **Ondo on BSC**, wrapped as `nep141:bnb-0x…omdep.near`, 18 decimals. Examples:
  - TSLAon `nep141:bnb-0x2494b603319d4d9f9715c9f4496d9e0364b59d93.omdep.near`
  - NVDAon `nep141:bnb-0xa9ee28c80f960b889dfbd1902055218cba016f75.omdep.near`
  - SPYon `nep141:bnb-0x6a708ead771238919d85930b5a0f10454e1c331a.omdep.near`
  - The full set is in `scripts/check-tokens.mjs` output.
- **xStocks: none found.** Neither list (with or without `?ondoTokens=true`, with or without the API key) has any `…x` equity symbols. The only `*x` symbols are `USDCx`, which is not an equity. Nothing matches the Solana mint of NVDAx (`Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh`). Web search found no NEAR Intents support for xStocks. So today multi-issuer routing has **one issuer (Ondo)**. The registry should still be built issuer-agnostic (ticker → list of routable assets), so xStocks will work if 1Click adds them. This should be re-checked on Nov 1.
- **Correction to my earlier note.** I first guessed the "No liquidity" result was market hours. That was wrong. The real cause is a **minimum quote size**. With USDC held in Intents, dry quotes to NVDAon return `No liquidity available` at $3, $5 and $25. They succeed at $28, $30, $33, $36, $40, $50, $60, $75, $90 and $100. TSLAon and SPYon also quote at $100. The floor is therefore about $25–28 (probably solver-side). Consequences:
  - Equity swaps can't be $1–5. The smallest realistic live test is about **$30**, and the CLAUDE.md demo line "Buy $3 of NVDA" won't work. This needs your decision before any mainnet test.
  - Map this to `NO_LIQUIDITY` (market-closed code removed; it was never in the schema or CLAUDE.md, and CLAUDE.md now documents `NO_LIQUIDITY`).
- Sell side: NVDAon → USDC quotes at about $105 (0.5 NVDAon). Not tried at small sizes.
- Quote slippage at $100 is about 0.4–0.6% below the reference price, so the `PRICE_SANITY` threshold should start around 2%.
- Practical notes: 1Click sits behind Cloudflare and rejects Python's default `urllib` User-Agent (HTTP 403, code 1010), so set a UA. The `confidentiality` enum is lowercase (`public|basic|advanced`).

## 2. Confidential Intents
- With the API key, dry quotes succeed with `depositType`, `recipientType` and `refundType` = `CONFIDENTIAL_INTENTS` and `confidentiality: "basic"`:
  - USDC → SOL, about $3.
  - USDC → NVDAon, $100.
  (Before the key was added, the same calls returned 401.)
- The docs say Confidential Intents makes deposits and withdrawals unlinkable. They don't explain `basic` vs `advanced`, and I haven't tested `advanced` on an embedded balance.
- Executing from a confidential balance uses the signed-intent flow: quote, `POST /v0/generate-intent` (`swap_transfer`, `nep413`), sign, `POST /v0/submit-intent`, poll `/v0/status`.
- Quotes with a `DESTINATION_CHAIN` recipient need a valid chain address. My test addresses were rejected, so the foreign-to-foreign path is untested.
- Still unverified: that a signed intent from a custodial TEE key is accepted end to end. That needs a mainnet spike, which needs your confirmation.

## 3. Hosting and custody: options compared

| | **OutLayer Agent Custody** | **IronClaw (NEAR AI Cloud)** | **Phala dstack + Shade Agents** | **Shield key** |
|---|---|---|---|---|
| What it is | Managed TEE wallet. Agent gets an API key; keys are derived in Intel TDX | Open-source Rust agent runtime (WASM tools), one-click deploy in a TEE | Generic Docker in a TDX TEE; on-chain agent contract approves code measurements and grants MPC signing | NEAR Intents' incident and circuit-breaker service (`key_type: SHIELD`) |
| Signs 1Click/Intents swaps | **Yes.** `/wallet/v1/intents/swap` and `/confidential/swap` (plus shield, unshield, withdraw, transfer) | No wallet or intents story | Possible, but we build signing and intents ourselves | n/a |
| Policy | Per-tx, hourly, daily and monthly limits, address allow/deny lists, time windows, rate limits, capability default-deny (`swap`, `cross_chain_withdraw`, `raw_sign`). **Set by the owner in OutLayer's dashboard. No write API found**; the agent key can only read it | Not applicable | We build it | Not a policy engine |
| Agent key model | `wk_` API key; sub-agent delegate keys can be issued and revoked. Bounded by policy | Credentials in an encrypted vault, injected at the host boundary | We build it | JWT (`status_read` grant to read) |
| Attestation | TDX quote (MRTD, RTMR0–3) checked via `is_measurements_approved` on `worker.outlayer.near`; code identified by `wasm_hash`. Docs don't give a clear retrieval endpoint | Not described | dstack remote attestation; contract stores approved measurements (agents are stateless) | n/a |
| Mainnet | Yes (Intents is mainnet-only; endpoints return 503 on testnet) | Yes | Template started on testnet; not formally audited | Yes |
| Owner can always recover | **Sovereign vault**: owner-controlled recovery after an exit window (1–30 days), plus DAO-cessation recovery. Costs 1 NEAR to deploy, needs about 0.5 NEAR standing balance | n/a | We design it | n/a |
| Pricing | Pay per transaction. Fee schedule not found | Starter $0 (1 instance), Basic $20, Pro+ $200 | Phala hosting fees | Free to read |
| Main risks | Cumulative limits can be exceeded by concurrent requests. On swaps the TEE doesn't re-check token or amount; the gateway is trusted. Response shapes are undocumented. No policy write API. Unknown whether equity `omdep` tokens appear in its catalog | Docs don't show hosting custom services. It's an agent runtime, not a service host | Most code to write; unaudited | Can't gate trades per vault; adaptive circuit-breaker keys are **not in the public docs** (the partner portal needs login) |

Shield: the public docs describe incident-based controls. `GET https://shield.chaindefuser.com/incident` returns `operational` or a list of incidents scoped by chain, bridge, token or address. Submitting incidents needs a grant from Intents Support. I found nothing about adaptive keys; that is in the login-gated portal, which I did not open.

### Recommendation: OutLayer for custody and signing, Phala dstack for the Norr service
1. **Custody and signing: OutLayer.** It replaces our own keystore, the single most dangerous module to write, with a TEE wallet that already speaks Intents and Confidential Intents. It has a native owner-recovery path (sovereign vault) and gives the agent only an API key.
2. **Norr service on Phala dstack** (generic Docker, remote attestation). The enclave service holds the OutLayer key and enforces the rules OutLayer lacks: the registry and multi-issuer routing, risk checks, equity percentage, cooldown, and the private policy, log and strategy prompts. The agent only ever holds a Norr token. That keeps the "privacy by default" promise: OutLayer's policy is dashboard-only and can't hold these rules.
3. **Defence in depth.** The owner sets OutLayer's own policy as a hard outer envelope (capabilities, a destination whitelist, a daily cap), so even a compromised Norr service can't move funds out or choose an arbitrary destination.
4. **Shield:** use the read-only status feed as an extra pre-trade check, which fits the AI Security track. Don't depend on it.
5. **IronClaw:** don't use it to host the service. It could host a demo agent that connects to our MCP server.
6. **Fallback** if the OutLayer spike fails: Phala + Shade Agents with our own keystore, as planned in CLAUDE.md.

**Caveat (see the re-check above: equities look unsupported by OutLayer's catalog):** this recommendation is unproven. It rests on docs only. The checks that decide it need a mainnet-side spike: register a vault, then see (a) whether the equity `omdep` tokens appear in OutLayer's token catalog, (b) the real swap response shape and fees, and (c) whether the recipient can be pinned to the vault. That would be a tiny funded spike (about $1 for crypto, about $30 for equities), so I won't run it without your confirmation. NEAR AI Cloud does not host our container. The hackathon resources may list another hosting option; I haven't seen that list.

### OutLayer re-check (current docs and live read-only calls)
The comparison table above came from the retired `outlayer.fastnear.com` docs. The live API is **`https://api.outlayer.ai`**; the old host now answers HTTP 410 `api_moved`. Docs: `app.outlayer.ai/docs`, repo `github.com/out-layer/outlayer`. A wallet was registered on 2026-10-24 (default master, no on-chain transaction). Its key is in `.env` as `OUTLAYER_API_KEY`; the wallet's NEAR account is the implicit account `2005d442…4046` and `wallet_id` is `1b279dea-f677-44bb-a538-e71f65b7562e`. Balances are 0.

What changed or was newly learned:
1. **A wallet with no policy is unrestricted** (CUSTODY.md and the current agent-custody page). Default-deny capabilities (`swap`, `cross_chain_withdraw`, `confidential`, `raw_sign`, …) apply only **once a policy exists**. This wallet's policy is currently `"none"` (live `GET /wallet/v1/policy`). The earlier assumption that swap and withdraw were off by default was wrong. **The owner must set a policy in the dashboard before any funding.**
2. **Pricing:** no per-transaction fee is documented. The docs describe a **free tier of 100 custody operations per wallet per day** (dry-runs count; swap quotes don't), then HTTP 429, lifted by a subscription. The register response also had a `trial` field I did not store (I did not print the response, to protect the key). Its meaning is undocumented, so ask OutLayer or check the dashboard. The "pay per transaction" wording from the old docs isn't supported by the new ones.
3. **Policy is still dashboard-only for the owner.** Policies are stored on-chain (`store_wallet_policy`); the agent key can only `GET /wallet/v1/policy`. Schema: `rules.limits` (per_transaction, hourly, daily, monthly), `rules.addresses` (whitelist/blacklist), `rules.allowed_tokens`, `rules.transaction_types`, `rules.time_restrictions`, `rules.rate_limit`, `approval` (multisig threshold), `capabilities`, `frozen`. Hourly/daily/monthly limits are best-effort under concurrency. Per-transaction limits, whitelists, multisig and freeze are exact.
4. **Equity gap: OutLayer's token catalog (`GET /wallet/v1/tokens`) has 205 tokens, the same as the plain 1Click list, and no Ondo tokens** (no `NVDAon` or any `…on` equity). So **equity swaps through OutLayer's `/intents/swap` are unproven and probably unsupported by its catalog**. This weakens the recommendation for equities. Options if confirmed: (a) test whether `/intents/swap` accepts an Ondo `defuse` asset id that isn't listed; (b) have the Norr service build the 1Click quote and use OutLayer only to sign (`sign_message`/`raw_sign`), though `raw_sign` is a broad capability; (c) fall back to Phala + Shade for equity custody. Crypto is unaffected.
5. **Swap quote:** the public route isn't documented; only `/confidential/swap/quote` is. The dry-run for withdraws is `POST /intents/withdraw/dry-run`.
6. **Funding path:** `POST /wallet/v1/intents/deposit/cross-chain` takes a `source_asset` (or `chain` + `token`) and returns a deposit address that expires in 30 minutes. Send only that exact asset on that chain; wrong sends are "lost permanently". Using this avoids needing NEAR in the wallet. It is the proposed way to fund USDC from your NEAR account. `POST /intents/deposit` (from the wallet's own NEAR account) would need USDC and gas on the implicit account, which has 0 NEAR.
7. **Docs mismatch noted:** the agent-custody page shows `/register` returning no `wallet_id`/`trial`, but the live call returned both. Treat the docs as approximate and verify each response shape live.

**Updated cost estimate for the crypto-only test (hard cap $5):** unchanged in total, about $3 float with an expected net loss of about $0.05 to $0.10. OutLayer's own fee is likely $0 inside the free tier (100 ops/day), but the `trial` field and any fee remain unverified. The sovereign vault is still skipped.

### OutLayer trust model: swap and confidential are coordinator-trusted
From the current OutLayer docs (CUSTODY.md and the agent-custody page):
- For the "Trusted" operations (`swap`, `confidential`, `cross_chain_withdraw`, `limit_order`), the keystore TEE checks **capability + policy + multisig on the op fields and pins the recipient**. It **does not re-verify the 1Click artifact's token, amount or routing against the approved op**. The gateway ("coordinator") builds the quote and the **deposit address, which the TEE cannot independently verify**. OutLayer calls this "a documented tradeoff": a compromised coordinator could substitute token, amount or routing after approval. The guarantee is "the recipient pin and the approver signatures, not the value terms".
- Cumulative limits (hourly/daily/monthly, tx counts) use a counter the gateway supplies and are best-effort under concurrency. The docs contradict themselves on whether usage is recorded before or after execution. Only per-transaction limits, whitelists, multisig and freeze are described as exact.
- So **spending limits and approvals on swaps bind an honest coordinator**. They protect against a compromised agent, a compromised Norr service, or a prompt-injected LLM. They don't protect against a malicious or compromised OutLayer coordinator or gateway.

**What this means for Norr's custody claims**
1. Safe to say: the agent never holds keys, never sees or chooses a destination, and Norr's service holds only an OutLayer API key that is itself bound by an owner-set policy. Keys sit in a TEE wallet, and the owner can freeze it. A compromised agent or Norr service cannot withdraw outside the policy.
2. Not safe to say: "trustless", "non-custodial in the cryptographic sense", "cannot lose funds even if OutLayer is compromised", or "hard limits enforced by hardware" without qualification. Trust in OutLayer's coordinator and in Intel TDX remains. Withdrawals (`intents_withdraw`) and recipient pins are stronger than swap routing; exposure is greatest on swaps.
3. Privacy: OutLayer's gateway sees every operation (token, amount, recipient). Norr's privacy claim must be "hidden from the public chain and from other users", not "hidden from the custody provider". Strategy prompts and the policy rules Norr enforces stay inside Norr's own service.
4. Mitigations to build: (a) keep per-vault balances small and say so; (b) Norr independently requests its own 1Click quote and, after every execution, compares the result with the intended token, amount and recipient, then trips its own kill switch on a mismatch; (c) keep withdrawals approval-gated and whitelisted; (d) the sovereign vault is a recovery path for keys, not protection against coordinator tampering; (e) keep Phala + Shade as the fallback where Norr's own attested enclave builds the quote and signs, which would move this trust to code anyone can verify.
5. README wording (proposed): "Keys live in OutLayer's TEE wallet, and the agent never touches them. The owner sets spending limits, a withdrawal whitelist and approvals in OutLayer, enforced inside its TEE. Known limitation: for swaps, OutLayer's gateway builds the route and deposit address and its TEE does not independently re-check the token, amount or deposit address, so these limits assume an honest OutLayer gateway. Norr adds its own pre-trade checks and a post-trade comparison against its own quote to catch tampering."

### OutLayer policy actually stored (checked 2026-10-24 via `GET /wallet/v1/policy`)
- Approval threshold 1, approver `legalalienx.near` (admin), no excluded types, so every fund-moving operation waits for that approval (`/wallet/approvals`).
- Native limits: per-tx 0.5 NEAR, daily 1, monthly 1, hourly 10 (the hourly value is higher than the daily one, so daily binds).
- Whitelist `legalalienx.near`; transaction types `transfer`, `call`, `intents_withdraw`, `intents_swap` (the dashboard writes `intents_*`, the docs say `swap`/`withdraw`); capabilities: `swap` allowed, `evm_sign` and `solana_sign` off, the rest default-deny.
- **No `rate_limit` is stored.** The "10 tx/hour" intent landed in the native hourly limit (10 NEAR) instead.
- No token-specific limits and no `allowed_tokens` yet.

### OutLayer policy applied and verified (2026-10-24)
The token-limit policy was saved and `GET /wallet/v1/policy` matches it exactly (rules, approval, capabilities, key hash). OutLayer has a swap quote route, `POST /wallet/v1/intents/swap/quote` (`token_in`, `token_out`, `amount_in`; returns `amount_out`, `min_amount_out`, `time_estimate_seconds`). For 1.5 USDC to SOL it returned `amount_out` 14959584 and `min_amount_out` 14809988, **identical to Norr's own 1Click dry quote**. That agreement is what `verifyExecution` in `packages/core` relies on for the post-trade check.

### OutLayer deposits are gated as `call` (found 2026-10-30)
- The whole deposit family (`intents/deposit`, `storage-deposit`, `intents/deposit/cross-chain`) is evaluated as policy type **`call`**; there is no separate deposit type (legacy names `intents_deposit` etc. are normalized to `call`). A policy without `call` returns HTTP 403 `policy_denied: Transaction type 'call' is not allowed` even for the cross-chain route, which only returns a deposit address.
- Cross-chain deposits (`source_asset` must be prefixed, e.g. `nep141:…`; bare ids give HTTP 400) are documented to return a per-request address (30 min expiry) that the user funds from another chain; no NEAR-side contract call is documented. For NEAR-source funds the docs recommend `POST /intents/deposit`, a direct `ft_transfer_call` from the wallet's own account to `intents.near`.
- **Not documented:** whether `rules.addresses` is checked against deposit targets, and what contract the cross-chain `call` targets.
- **Naming risk:** the docs list policy types `transfer, call, withdraw, swap, cross_chain_withdraw, limit_order, delete, …`, but the dashboard wrote `intents_withdraw` and `intents_swap` into this wallet's policy. Whether the gateway maps those to `withdraw`/`swap` is unconfirmed. The post-funding withdraw dry-run should show it; if it is denied, add `withdraw` and `swap`.

### Funding the OutLayer wallet: what the policy needed (2026-10-30)
Requesting a cross-chain deposit address (`POST /intents/deposit/cross-chain`, `source_asset: "nep141:…"`) needed **three temporary policy entries**, found one denial at a time: `call` in `transaction_types`, `native` in `allowed_tokens` (the `call` is checked against native NEAR), and `intents.near` in `addresses.list`. So the whitelist **is** applied to deposit targets, and the cross-chain route does touch `intents.near`. The response gave `intent_id`, `deposit_address` (a 64-hex NEAR implicit account), `amount_out` (1:1 for USDC), `min_amount_out` (1% slippage) and an `expires_at` that was three days out, not the documented 30 minutes. Treat the shorter window as the safe assumption. The response also hints that `POST /intents/deposit` is a one-transaction path if the wallet holds NEAR for gas. Remove the three temporary entries after the deposit lands.

### OutLayer funded test: results so far (2026-10-30)
- **Funding worked.** 3.0 USDC reached the wallet's Intents balance (`mt_balance_of` on `intents.near` for the wallet's implicit account), confirmed on-chain; the deposit status endpoint reports `success`. The three temporary policy entries were removed afterwards.
- **Withdraw dry-runs on the final policy:** to the whitelisted `legalalienx.near`: `would_succeed: true`, "would require multisig approval", `address_allowed: true`, `within_limits: true`, `estimated_fee: "0.002"` in NEAR. To a non-whitelisted address: `policy_denied`, "Address … is not in whitelist". So the whitelist binds withdrawals and `intents_withdraw` is recognised as the withdraw type. Whether `intents_swap` is recognised as swap is still unconfirmed.
- **Open cost question:** the withdraw fee is quoted in NEAR (about 0.002 NEAR) and the wallet holds 0 NEAR. Unknown whether it is taken from the wallet's NEAR, from the Intents balance, or makes the withdraw fail.
- **Quote agreement is close, not exact:** for 1.5 USDC to SOL, OutLayer quoted 15429356 (min 15275062) and Norr's own 1Click quote 15430264 (min 15275961), a 0.006% gap seconds apart, whereas the first comparison was identical. `verifyExecution` should therefore check the executed output against a tolerance band around Norr's quote, not exact equality with OutLayer's quote.

### First live swap: 1.5 USDC to SOL (2026-10-30, request `428c452f-…`)
- **Result:** status `success`. On-chain Intents balances: USDC 3,000,000 to 1,500,000 (spent exactly 1,500,000); SOL 0 to 15,425,919 (0.015425919 SOL, worth about $1.4986). Swap gasless; no NEAR used.
- **`verifyExecution`: passed** against Norr's own pre-trade 1Click quote (min 15275961), using 1Click's independent status endpoint for tokens, amounts and recipient (`recipient` = the wallet's own account). Executed output was 4,345 units (0.028%) below Norr's pre-trade expected output, well above the minimum. The independent check works: the status endpoint, keyed by the gateway's deposit address, returns the route and amounts without relying on OutLayer's own report.
- **`min_amount_out` was not enforced.** The request carried `min_amount_out: "15275062"`, but the 1Click quote OutLayer actually used had `slippageTolerance: 100` (1%) and `minAmountOut: 15269655`, which is **lower** than the requested bound. So the field is accepted but ignored (the docs list only `token_in`, `token_out`, `amount_in`). The outcome here was well above both numbers, so there was no loss, but a slipping market would not have been stopped by it.
- **The quote is made at approval time, not request time:** the request was created at 08:02:03 and its quote is stamped 08:05:24, when the owner approved. With approval-gated swaps, the executed price is whatever the market gives minutes later.
- **Consequence for the "never swap without `min_amount_out`" rule:** through OutLayer's swap endpoint Norr can send the bound but cannot make it binding, so protection is after-the-fact (`verifyExecution` plus the kill switch), and per-trade size limits matter more. A route where Norr sets `slippageTolerance` in its own 1Click quote (the Phala + Shade fallback, or signing intents ourselves) would make the bound enforceable. Treat this as a known limitation in the README.
- Total spent on the OutLayer spike so far: about $3 of USDC float, held in the wallet, no measurable fees on swap or deposit.

### Limit orders as an enforced-minimum swap (docs only; nothing enabled)
Source: OutLayer CUSTODY.md and agent-custody docs, plus 1Click's limit-order docs.
- **How it works:** `POST /wallet/v1/limit-orders` (`base_asset`, `quote_asset`, `side`, `quantity`, `price` = quote per whole base unit, optional `recipient`, `recipient_type`, `deadline`, default 7 days) rests an order on 1Click funded from the wallet's Intents balance. OutLayer says a price through the market fills immediately, and otherwise it rests and can fill in slices.
- **Why it helps:** on a multisig wallet approvers sign "what is sent and the least it must return". The coordinator computes those terms, the order is created unfunded at 1Click, and **the order is cancelled with nothing sent if 1Click's figures are worse than the authorised terms**. So the minimum is checked before funding, which the swap endpoint never did. It is still a coordinator-trusted operation (the TEE pins the recipient and checks approver signatures, not token or amount).
- **Unverified:** whether a marketable order fills at the limit price or at the better market price (the docs imply "at least the limit" but do not say); how long an immediate fill takes; the 1Click `app_fees` rate; 1Click requires non-public confidentiality for orders (OutLayer presumably handles this).
- **Costs and hazards:** minimum order 0.1 USD; 1Click takes `app_fees` from the input; **a resting order survives a freeze and Norr's kill switch** until cancelled (cancel and cancel-all are never policy-gated), so the kill switch must call `cancel-all`; always set a short `deadline`, or a stale order could fill days later at the old limit; poll the individual order, and treat `is_payout_status_final` as the only terminal signal.
- **Policy change it would need** (not made): `capabilities.limit_order: { "allowed": true }` and `"limit_order"` in `transaction_types` (the dashboard's single switch sets both); the wallet's own account `2005d442…4046` added to `addresses.list`, because address rules apply to the recipient even when it defaults to the wallet's own Intents balance; nothing else (SOL and USDC are already in `allowed_tokens`, and amount limits apply to what the wallet sends). The `confidential` capability would be needed only for a `confidential_intents` recipient.
- **Assessment:** better than the swap endpoint for the bound, but not trustless, and it adds resting-order risk. Worth one $1.50 spike after the current test.

## 4. Equity eligibility
- The NEAR Intents docs say nothing on Ondo restrictions or required disclaimers. Their risk page only covers their own AML screening of quote addresses.
- Third-party sources: Ondo Global Markets tokens are for **non-US persons**, with additional restrictions. Until there's an official answer, the owner should confirm non-US status before enabling equities, and show a disclaimer. This maps to `INELIGIBLE`. **Still needs your confirmation.**

## 5. API key
In `.env` as `ONECLICK_API_KEY`. It was used for the quotes above and was never printed or logged.

## Decisions needed
1. Approve the recommendation (OutLayer custody, Phala-hosted Norr service), or pick another option.
2. Approve a small funded OutLayer spike later (registering a vault and one tiny swap each way), or tell me to keep going on `packages/core` first.
3. Equity minimum: the smallest live equity test is about $30. Is that acceptable, and should the demo change?
4. Confirm the non-US-only handling for equities.
