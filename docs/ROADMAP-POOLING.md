# Roadmap design: pooling small stock orders (NOT BUILT, NOT APPROVED)

**Status: idea only. Do not build or ship without legal review.** Nothing in the repository implements this.

## The problem
A user wants $2-$5 of a stock, but the Ondo path through NEAR Intents will not quote below about $5 (liquid tickers) or $26 (the rest), and positions under about $5 cannot be sold. Pooling would let several small orders share one larger one.

## Sketch
1. **Batch window.** Orders for the same ticker and direction queue for a short window (for example 60 seconds, or until the pool crosses the floor for that ticker).
2. **One trade.** When the pooled amount clears the minimum, Norr executes one swap for the pool, with `min_amount_out`, from a pool vault.
3. **Allocation.** The fill is split pro rata by dollars committed, at the pool's average price; rounding dust goes to a reserve. Each user's share is a **ledger entry** (claim), not a token in their own vault.
4. **Selling.** A sell order queues the same way; shares are matched internally against queued buys first (netting) and only the net goes on-chain.
5. **Failure handling.** If the window ends below the floor, orders are refunded, or held for the next window if the user opted in.

## Why it helps
- Unlocks sub-$5 orders and fractional exits from tiny positions.
- Netting reduces on-chain trades and fees. With confidential execution, individual order sizes are hidden from the public chain (not from Norr or the custody provider).

## Trade-offs
**Custody**
- Pooled assets sit in one omnibus account, so users no longer hold their own position in their own vault. The core promise ("the agent never holds your keys, you can always withdraw") weakens to "Norr's pool owes you a claim".
- The owner-recovery property is lost for pooled holdings: if Norr or the pool operator fails, users depend on the operator's records.
- Needs per-user ledger integrity, reconciliation against on-chain balances, and a clear rule for who bears slippage, failed fills and dust.
- Price fairness: late joiners, partial fills and average-price allocation must be defined and auditable.

**Regulatory (questions for counsel, not conclusions)**
- Ondo's tokens are offered to non-US persons only; a pool must enforce that per participant, which means identity and residency checks Norr does not do today.
- Holding customer assets for many users and issuing claims on them can look like custody, brokerage, a collective investment scheme or an exchange, depending on the jurisdiction. Fractional claims on a security are not the token the issuer minted.
- Operating a pool may trigger licensing, AML/KYC and disclosure duties that the current model (each owner funds and controls their own vault) avoids.
- The agent trading on behalf of users adds a discretionary-management question.

## Alternatives that avoid pooling
- Set an honest minimum per ticker ($5.10 or $26) and explain it (cheap, built on current findings, see `docs/EQUITY-MINIMUMS.md`).
- Ask NEAR Intents or Ondo about lowering minimums (question drafted there).
- Let one owner's vault keep a standing position and sell it down in large enough pieces (still blocked for dust below the floor).

## If it were ever built
Phase 0: legal review and a written product definition. Phase 1: single-user "batch my own orders" (no pooling across users, no custody change). Phase 2: opt-in pools with explicit disclosures and per-user eligibility checks. Phases 1 and 2 reuse `verifyExecution`, the daily caps and the confidential venue.
