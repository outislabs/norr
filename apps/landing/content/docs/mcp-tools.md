# MCP tools reference

Nine tools. Eight only read; `trade` can move money, inside the vault only. No tool can withdraw, change rules, or accept a destination address.

| Tool | Inputs | What it does |
|---|---|---|
| `list_assets` | `class` (optional: `crypto` or `equity`) | What can be traded. Crypto by symbol and chain; stocks and ETFs by ticker with every issuer that offers it, and the smallest order that has been quoting (`minimumUsd`). |
| `get_market_data` | `asset` | Numbers, not advice: the listed price and, for crypto, the market signals Scam Shield scores (liquidity, market cap, token age) with the risk level. For stocks, price per issuer and the quoting minimum. |
| `check_asset` | `asset` | A verdict before trading. Crypto: Scam Shield's risk level (low, medium, high) with reasons. Stocks: whether this vault may trade them, and the notice to respect. Also any active NEAR Intents security incident touching the asset. |
| `get_quote` | `side`, `asset`, `amountUsd` | A dry run: the price and the minimum you would accept. No funds move. If a rule would stop the trade, you get the same blocked answer `trade` would give. |
| `trade` | `side` (`buy` or `sell`), `asset`, `amountUsd`, `reason` (optional, private to the owner) | Requests a trade. Runs every check, quotes, executes through NEAR Intents (confidential layer when the funds are there) and verifies the result. |
| `get_portfolio` | none | Holdings in USD, split into crypto and tokenized stocks. |
| `get_pnl` | none | Profit and loss since the vault's first trade, per asset and in total: realized (sells at average cost) and unrealized (what is still held from Norr's buys, at today's price). Deposits have no known cost and are not counted. |
| `get_policy` | none | The rules: largest trade, daily spending cap and what is left today, daily loss cap, stock share, allowlists, cooldown, whether stocks are enabled, whether the vault is paused. |
| `get_activity` | none | Recent requests and outcomes, newest first. Use it to follow up on a trade waiting for approval. |

`asset` is a symbol (`SOL`, `USDC`), a ticker (`NVDA`, which Norr routes to the best-priced issuer), or a NEAR Intents asset id.

## What `trade` answers

| Status | Meaning | What the agent should do |
|---|---|---|
| `executed` | It happened. Includes the fill (asset, amount, price), `venue` (`confidential` or `public`) and `verification` (`independent`, or `custody-reported` for confidential swaps). | Nothing; check `get_portfolio` if needed. |
| `blocked` | A rule or safety check stopped it. Includes a `code` (below) and a plain-language `message`. | Adjust the request; do not resend it unchanged. |
| `pending_approval` | The owner must approve it in the custody provider first. | Do not resend. Follow up with `get_activity`. |
| `failed` or `refunded` | It did not complete; nothing was lost. | Read the message. |

## Block codes

| Code | Why |
|---|---|
| `PAUSED` | The owner paused this vault (or everything). |
| `OVER_TRADE_LIMIT` | Larger than the vault's largest single trade. |
| `DAILY_SPEND_CAP` | Buys today would pass the daily spending cap (stops one big trade being split into many small ones). |
| `DAILY_LOSS_CAP` | Realized losses today reached the cap; buying stops, selling still works. |
| `COOLDOWN` | Too soon after the last trade. |
| `ASSET_NOT_ALLOWED` | Not on the vault's allowlist. |
| `EQUITY_LIMIT` | Would push stocks above the vault's allowed share. |
| `INELIGIBLE` | Stocks are off until the owner confirms non-US status. |
| `SCAM_RISK` | Scam Shield rates the token high risk (or medium, when the vault does not allow medium). |
| `SHIELD_INCIDENT` | Only when the deployment has the incident feed configured: an active NEAR Intents security incident touches the asset, or the feed cannot be read (Norr fails closed). Every answer's `incidentFeed` field says whether the feed is active or not configured. |
| `PRICE_SANITY` | The quoted stock price is more than 2% from the reference price, or there is no reliable reference. |
| `UNKNOWN_ASSET` | Not in the asset list. |
| `NO_LIQUIDITY` | No route quoted for that size. |
| `PRIVACY_UNAVAILABLE` | The vault requires the confidential layer and the trade cannot run there. |
| `PRICING_UNAVAILABLE` | The service has not loaded market data yet (it keeps retrying). |

Tokenized markets trade around the clock, so there is no market-closed code; stock minimums are higher outside US market hours.
