# Asset modes: Curated and Open (proposal, not built)

Status: proposed 2026-11-05 for Kelvin's decision. Contract-address lookups and look-alike handling are already built
(`Registry.lookup`, `AMBIGUOUS_ASSET`); this document covers which assets a vault may trade and how that maps to the
custody policy.

## What the owner chooses

At vault creation, and later in Rules:

- **Curated** (default): majors and top stocks. Crypto: USDC, SOL, ETH, BTC (and wNEAR); stocks: the tickers whose
  minimum order fits the vault's largest trade (today NVDA, TSLA, QQQ, AAPL, AMZN, GOOGL at a $10 limit). The owner can
  add or remove assets, including by chain and contract.
- **Open**: any asset in NEAR Intents' catalog (crypto and stocks) that passes Scam Shield (market data and GoPlus on the
  exact contract) and the owner's rules, within the trade limits. Look-alike symbols are refused until the exact contract
  is named (built).

Norr's own rules (`packages/core`) stay exact in USD and run first in both modes. The custody policy is the hard backstop.

## How each mode maps to OutLayer's custody policy

Facts (OutLayer's policy tests, `tests/hos_custody_matrix_e2e.sh` F and G, and live usage counters): `allowed_tokens`
takes a list or `["*"]`; limits are per token **in that token's own units**; a token with no limit entry has no
per-transaction limit; a swap is metered on the token it sends (every buy so far counted as USDC spent).

| | Curated | Open |
|---|---|---|
| `allowed_tokens` | The listed assets' ids (every issuer's version of a listed stock) | `["*"]` |
| Per-transaction and daily limits | Per listed token, converted from the USD caps at the price of the day, with 25% headroom (as today) | **USDC only** (the spend side): every buy spends USDC, so buys are capped exactly in USD. No per-token limits on other tokens |
| Rate limit, whitelist, approval, types, capabilities | Same as today | Same as today |
| What the backstop bounds if Norr's service or OutLayer's gateway misbehaves | Buys and sells, per token, per day | Buys exactly; **sells only by the rate limit (10 an hour) and the approval step**. Proceeds can never leave the vault (whitelist), and the vault holds at most $100 in the beta |

Why not USD limits on every token in Open: the custody policy has no USD unit, the catalog has about 215 tokens (the
stored policy must stay under the contract's 16 KB event log limit, so roughly 30 to 40 per-token entries at most), and
token-unit limits drift with price. Spend-side limits are exact and small.

**Recommendation:** Open with approvals on is as safe as Curated for losses through the custody provider, since every
operation needs the owner's signature. Open with autonomous mode trades that for convenience: sells of held tokens are
bounded only by the rate limit, the approval-free window and the beta's $100 cap. I would allow it, with that sentence
shown at the switch, rather than forbid it.

## Changing the list: one owner signature

The custody policy belongs to the owner on chain, so any change is the same flow as setup, from Rules:

1. The owner changes the mode or the list (or adds a token by chain and contract).
2. Norr prepares the new policy (keystore-encrypted, signed for the owner as caller) and shows the difference in words
   ("adds NEARKAT (near:kat.token0.near), limit about $12.50 per trade").
3. One transaction from the owner's wallet (`store_wallet_policy`, an update by the controller; the storage deposit
   changes by a few thousandths of a NEAR, refunded when it shrinks).
4. Norr reads the stored policy back and applies the matching Norr rules only when it matches, as at activation.

Norr's own rules (allowlists, caps) change with the same click, so the two never disagree. Until the owner signs, the old
custody policy still applies: Rules says "custody policy update pending: sign to apply".

## Why an asset is not tradable (shown in Rules and in check_asset)

One reason, in this order, with the fix:

| Reason | Example message | Fix |
|---|---|---|
| Not on NEAR Intents | "Not available on NEAR Intents yet, can't be traded privately." | None (roadmap: optional public route) |
| Ambiguous symbol | "Several tokens are called NEARKAT; pick one by contract." | Choose the contract |
| Not allowed by your rules | "Not in this vault's list (Curated)." | Add it, or switch to Open |
| Not in the custody policy | "Allowed by your rules, but your custody policy does not list it yet." | Sign the policy update |
| Failed a safety check | "High risk: honeypot (GoPlus)." | None; the asset is refused |
| Minimum above your trade limit | "Its minimum order (about $26) is above your largest trade ($10)." | Raise the trade limit (and sign) |
| Stocks need non-US status | "Confirm you are not a US person." | Confirm in Rules |

## Build estimate

About a day: the policy builder for both modes, the update flow (reusing activation's checks), the Rules screen
(mode switch, list editor with contract entry, pending-update banner, reasons), tests. The demo vault keeps its
hand-set policy.
