# OutLayer: `POST /wallet/v1/intents/swap` ignores `min_amount_out`

**Summary.** The swap endpoint accepts a `min_amount_out` field without error, but the 1Click quote it executes uses its own 1% slippage minimum, which can be lower than the minimum the caller asked for. The field is neither enforced nor rejected, so a caller can believe a bound applies when it does not.

**Environment.** Mainnet, `https://api.outlayer.ai`, default-master wallet, approval threshold 1 (owner approved in the dashboard). 2026-10-30.

**Request** (key omitted):
```
POST /wallet/v1/intents/swap
{ "token_in": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "token_out": "nep141:sol.omft.near",
  "amount_in": "1500000",
  "min_amount_out": "15275062" }
```
Response: `status: pending_approval`, request id `428c452f-b281-4db9-a59f-099f56bb198a`, approval id `88ea6cc9-c891-4390-b83d-850ed6eb73a8`, request hash `ac1b6c7ffabe3a3e66b5587233e2f8d89ca76e9eeef8e8ea09369e4232a011bd`.

**What executed** (from `GET /wallet/v1/requests/{id}` and 1Click `GET /v0/status?depositAddress=f75b449934d87232c065d7bfb828be8bdcd662c9916a05810b88660e88e2a940`):

| | Value |
|---|---|
| Requested `min_amount_out` | 15275062 |
| 1Click `quoteRequest.slippageTolerance` | 100 (1%) |
| 1Click `quote.minAmountOut` actually used | **15269655** (lower than requested) |
| Quote `amountOut` | 15423894 |
| Executed `amountOut` | 15425919 |
| Request created / quote timestamp | 08:02:03Z / 08:05:24Z (quote taken at approval) |

The executed amount was above both numbers, so there was no loss here. The issue is that the requested bound was not part of the executed quote.

**Expected.** Either (a) reject unknown or unsupported fields with a 400, or (b) honour `min_amount_out`: derive the slippage tolerance from it, or cancel if the 1Click quote's `minAmountOut` is below it, and show it on the approval screen and in the signed terms.

**Also noted.** The docs list only `token_in`, `token_out` and `amount_in` for this route. A related question: for limit orders the docs say approvers sign "the least it must return"; is the same planned for swaps?

## Observation / question: limit orders did not fill
Separate from the above, and offered as an observation rather than a bug. Two small limit orders on the same wallet (2026-10-30) never filled and were refunded in full at their deadline:

| Order | Terms | Market margin when placed | Result |
|---|---|---|---|
| `order_n9Yl89FFiWJrNVNzu35fb` | buy exactly 0.0154 SOL, limit 99.0 USDC/SOL, max spend 1.5246 USDC | about 0.7% above the cost at market (about 0.5% after the 20 bps fee) | `open` with 0 fills until `expired`; refund completed |
| `order_fV7pz6PTwtY5joRM7SJ3I` | same quantity, limit 102.0, max spend 1.5708 USDC | about 4% above market | `open` with 0 fills for 29 minutes, then `expired`; refund completed |

The docs say a price through the market fills at once. Is a minimum order size or solver depth expected for resting orders, or is there a fill delay we should wait for? Both refunds arrived in full (up to about 9 minutes after expiry).
