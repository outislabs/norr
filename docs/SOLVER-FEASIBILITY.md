# Feasibility: serving $1-$5 stock orders (research only, nothing built)

Goal under test: private $1 stock trades on NEAR rails. Researched 2026-10-30 from the NEAR Intents solver docs, the Solver Terms of Use, live read-only market data and OutLayer/Chain Signatures docs. Nothing here was built or sent.

## Recommendation
**Do not build a solver now.** Keep $5.10 private trades (confidential route, liquid tickers; $26 for the rest) as the default. Reasons, in order of weight:
1. **Access is gated by KYC/KYB.** (Update 2026-10-30: the project owner operates a registered limited company, so KYB is feasible after the hackathon; eligibility is still subject to the unpublished Restricted Jurisdictions policy.) The Solver Terms of Use make "KYC on principals and KYB on the Solver" conditions to API-key issuance. A solo hackathon builder without a legal entity cannot be sure of getting a key at all, and the lead time is unknown. Confidential quoting needs a second approval (private-relay credentials from the Defuse team).
2. **Quotes are binding and the downside is uncapped for the solver.** Once selected, a quote must be filled; "a Fade or Settlement default is a material breach", with indemnity and possible collateral; NEAR's own liability is capped at the greater of $1,000 and fees paid.
3. **The economics do not work for <$5 orders.** A 1% spread on a $1 order is one cent; inventory price moves (NVDA, plus gaps while US markets are closed) dwarf it. It is a subsidy, not a business.
4. **Rebalancing on PancakeSwap is thin, off NEAR rails, and public** (see below). Rebalancing through NEAR Intents itself is possible and stays on-rails.
5. **Time:** even with credentials in hand it is 6-8 engineering days (public only) to 11-14 (with confidential), against 11 working days left that are already committed to the dashboard, Phala attestation and the privacy layer.

Cheaper ways to move the $1 goal: the question to the NEAR Intents team (is the ~$5 floor a solver parameter, and would an existing market maker lower it?), the stated-minimum and dust UX already built, and pooling as a roadmap item (see `docs/ROADMAP-POOLING.md`).

## 1. Norr as a NEAR Intents solver

**What a solver is.** A market maker listens on the Message Bus (a WebSocket relay, `wss://solver-relay-v2.chaindefuser.com/ws`), prices quote requests for its configured pair, and returns signed quotes. The bus returns the best quotes to the user; the user signs; the bus bundles the matching intents and submits them to the Verifier contract, where the swap settles. The protocol can run without the bus (solvers can index the chain), but the bus is how flow arrives.

**What the Solver API key enables.** Per the quickstart: request an API key through the Partner Portal and complete KYC/KYB; the WebSocket endpoint requires the Partner JWT. The docs do not show a separate `key_type` for solvers.

**How a solver quotes and settles (public layer).** Source: the example AMM solver (`defuse-protocol/near-intents-amm-solver`).
- Subscribe to `quote` and `quote_status`; answer only for the configured pair.
- Compute the price from current reserves plus a margin; build a `token_diff` intent (tokens received positive, given negative); serialize and sign it as NEP-413 with the solver's NEAR key.
- Reply with `quote_response` (the original `quote_id`, a `quote_output` carrying `amount_out` or `amount_in`, and `signed_data`).
- On `quote_status` (carries `quote_hash`, `intent_hash`, `tx_hash`) refresh balances. Reserves are read from `intents.near` (`mt_batch_balance_of`) every 15 seconds.
- Setup: register the signer's public key on `intents.near` (`add_public_key`) and deposit both tokens of the pair into `intents.near`. The solver fills only if it holds both.
- The example has no hedging, rebalancing, position limits or exposure controls; the docs list those as things you must add.

**Confidential (`CONFIDENTIAL_INTENTS`).** Source: the solver guide. Needs private-relay URL and credentials from the Defuse team (same Partner JWT scheme). Liquidity must be shielded into a confidential balance on the private chain before quoting. A quote has an optional `shield`, a required `swap` with exactly one `token_diff`, and a required `recover` if a shield is present (otherwise rejected); nonces must be versioned (encoding salt and deadline) via the SDK; act only on `quote_settle_successful` before releasing funds; confidential quotes arrive as `QUOTE_STATUS_EXTENDED`. No eligibility criteria are stated, and nothing explains how a solver gets the user-session token needed to read its own confidential balance.

**Terms that bind a solver (Solver Terms of Use).**
- KYC on principals and KYB on the solver entity, refreshed over time; Restricted Persons and jurisdictions are barred (no country list in the document).
- Own liquidity: quote, fill and settle "as principal"; maintain liquidity sufficient to honour what you quote. No minimum quote count or fixed inventory is stated (may come from Performance Standards or a commercial agreement).
- Firm quotes, no last-look or re-quotes; a fade or settlement default is a material breach with indemnity; throttling, deselection or suspension on poor performance; a bond or deposit may be required.
- Run your own KYT/AML screening; keep records seven years; report security incidents within 24 hours.
- RWAs: no representation on legal characterisation; the solver bears the legal and licensing responsibility; further asset or route restrictions can be imposed within five business days; issuers (Ondo) can pause or blocklist an asset, which can freeze your inventory.
- Revenue is the spread, net of a protocol fee that "may change at any time without notice"; BVI law, arbitration.

**Minimum viable scope for one pair (USDC <-> NVDAon), public layer only.** Quote only orders under $5 (leave larger ones to others); price from a reference feed with a margin (about 1%); inventory caps and a kill switch; one signer key (a hot key inside the Norr TEE; OutLayer is a poor fit because its free tier is 100 operations a day and every call is a network round trip); balance refresh as in the example; mock mode and tests.

**Inventory.** Both legs inside `intents.near`. Example: $500 of USDC plus $500 of NVDAon would cover many sub-$5 orders but leaves roughly $500 of NVDA exposure. Sources for NVDAon: buy through 1Click (floor about $5.10 per purchase, 0.15-0.4% cost), Ondo's own mint (access and minimum unclear: one press report says $1, another says $100k for some products and that KYC applies), or the PancakeSwap pool below.

**Rebalancing.**
- *Through NEAR Intents (recommended if anyone builds it).* Treat the solver's own drift as ordinary trades through the existing Norr/1Click pipeline in lots of at least $5.10 (liquid) or $26 (others), public or confidential. It stays on NEAR rails, and the code largely exists.
- *Through PancakeSwap.* Not available through Intents: the swap itself would be a direct DEX call, which `CLAUDE.md` rule 3 forbids ("no direct DEX routers"); using it would need an explicit rule change. Signing would work via Chain Signatures (see section 3).

**Risks.** KYB and jurisdiction eligibility; binding quotes and indemnity; NVDA price risk and weekend gaps (adverse selection: informed traders hit stale quotes when the US market moves while Ondo trades); issuer pause or blocklist freezing inventory; regulatory characterisation of acting as principal in tokenized securities; the protocol fee can change without notice; solver key theft (a hot key); one-signature-per-second style throughput limits in the example's nonce scheme; confidential access dependent on a manual approval.

**Estimated effort** (engineering days, only after credentials exist):

| Piece | Days | Gate |
|---|---|---|
| Single-pair public solver, pricing, inventory, limits, mock, tests, Phala run | 4-5 (+1 for a tiny mainnet run) | Partner Portal key after KYC/KYB (unknown lead time) |
| Rebalancing through the existing 1Click pipeline | 1-2 | none |
| Confidential quoting (shield/recover, versioned nonces, private relay) | 4-6 | Defuse approval (unknown) |
| PancakeSwap rebalancing (not recommended) | 3-4 | explicit rule change |
| **Total** | **about 6-8 public-only, 11-14 with confidential** | |

## 2. PancakeSwap on BSC (read-only, 2026-10-30 ~16:30Z)
| | NVDAon | TSLAon |
|---|---|---|
| Pools found | one: PancakeSwap v3 NVDAon/USDT | one: PancakeSwap v2 TSLAon/ASX (an obscure token, not a stablecoin) |
| Liquidity | about $22,200 | about $3,500 |
| 24h volume | about $6,400 (9 buys / 67 sells) | about $100 (2 / 10) |
| Pool fee | **1.0%** (read from the pool contract) | v2 default |
| Pool price vs 1Click reference | $207.97 vs $206.90 (+0.5%) | $389.90 vs $401.96 (**-3.0%**) |

Gas is negligible: BSC gas price 0.05 gwei, BNB about $700, a swap of 120k-300k gas costs $0.004-$0.011. The cost is the pool fee (1%) plus price impact, which on $22k of liquidity is small for $1-$100 but grows quickly beyond a few hundred dollars. TSLAon has no usable exit: $3.5k against an unrelated token at a 3% price gap. Absorbing a solver's rebalancing through these pools would cost about 1% plus impact per leg on NVDAon and is impractical on TSLAon.

## 3. Direct PancakeSwap route (comparison only; conflicts with privacy and rule 3)
Flow for a user's $1 trade: withdraw USDC from Intents to a BSC address, swap on PancakeSwap (the only NVDAon pool is against USDT, so a USDC to USDT hop first), hold NVDAon on the BSC address, and later swap and deposit back.
- **Signing options.** *Chain Signatures:* the docs list EVM networks including BNB Chain; a NEAR account plus a derivation path gives a deterministic 0x address; the app builds the transaction, asks `v1.signer` to sign, and broadcasts it itself; the address needs BNB for gas; use a distinct derivation path per chain (replay risk with legacy transactions). *OutLayer `evm_sign`:* `sign-transaction` needs both `evm_sign` and the `raw_tx` sub-flag; the client builds and broadcasts; **`requires_approval` is not supported for `evm_sign`**, there is no documented chain, contract or function allowlist, and it "grants full authority over the EVM address's float" (separate from the Intents balance). That is a much weaker control surface than the policy limits and approvals used elsewhere.
- **Cost for a $1 order** (measured/estimated): bridge out about 0.95% ($0.0095 on $1, falling to 0.2% at $5), pool fee 1%, gas about $0.007 (0.7% of $1), plus the same again on the way back: roughly 5-6% round trip, against about 0.15-0.4% each way on the Intents route at $5.10 and above.
- **Privacy.** Public on BSC: the address, amounts and timing of every leg, the token held, and the on-chain link from the bridge. It also puts the position outside the confidential layer and outside the vault's custody policy. It fails the privacy-first requirement, and rule 3.
- **Verdict.** Technically possible and cheap in gas; wrong for Norr.

## Open questions for the NEAR Intents / Defuse team
Add to the Telegram question already drafted: is a solver API key available to an individual outside a company; what are the Performance Standards for a new solver; is there a lower minimum or a "small order" lane; what does private-relay access require.
