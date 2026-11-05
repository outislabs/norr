# MCP tools reference

Ten tools. Nine only read; `trade` can move money, inside the vault only. No tool can withdraw, change rules, or accept a destination address. On connecting, the server also sends short instructions: how custody, approvals, privacy and storage work (call `about_norr` for the live details).

**Naming a token.** Anywhere an `asset` is taken you can pass a symbol (`SOL`), a stock ticker (`NVDA`), an asset id from `list_assets`, or the exact token as `chain:contract` (`base:0x833589…`), or the separate `chain` and `contract` inputs. A contract NEAR Intents does not route gets a safety report and the answer that it can't be traded privately. If several different tokens share a symbol (look-alikes), Norr does not guess: the trade is refused with `AMBIGUOUS_ASSET` and the candidates' chain and contract.

| Tool | Inputs | What it does |
|---|---|---|
| `about_norr` | none | How Norr works for this vault, from the running service: who holds the keys and controls the custody policy, what the agent can and cannot do, whether swaps wait for the owner's approval (where, with a link, and the 24-hour expiry), who can see what, what Norr stores, attestation status with a verify link, and the incident feed status. |
| `list_assets` | `class` (optional: `crypto` or `equity`) | What can be traded. Crypto by symbol and chain; stocks and ETFs by ticker with every issuer that offers it, and the smallest order that has been quoting (`minimumUsd`); a stock whose minimum is above this vault's largest trade is flagged `aboveYourTradeLimit`. |
| `get_market_data` | `asset` (or `chain` + `contract`) | Numbers, not advice: the listed price and, for crypto, the market signals Scam Shield scores (liquidity, market cap, token age), the GoPlus contract findings and the risk level. For stocks, price per issuer and the quoting minimum. |
| `check_asset` | `asset` (or `chain` + `contract`) | A verdict before trading. Crypto: Scam Shield's risk level (low, medium, high) with reasons, including the GoPlus contract checks (`risk.contract`: findings, or why the contract was not checked). Stocks: whether this vault may trade them, and the notice to respect. Also any active NEAR Intents security incident touching the asset. |
| `get_quote` | `side`, `asset` (or `chain` + `contract`), `amountUsd` | A dry run: the price and the minimum you would accept. No funds move. If a rule would stop the trade, you get the same blocked answer `trade` would give. `approval` says whether the swap would wait for the owner (read from the custody provider's policy), where, and for how long. |
| `trade` | `side` (`buy` or `sell`), `asset` (or `chain` + `contract`), `amountUsd`, `reason` (optional, private to the owner) | Requests a trade. Runs every check, quotes, executes through NEAR Intents (confidential layer when the funds are there) and verifies the result. A `pending_approval` answer carries `approval`: where the owner approves (Norr dashboard, the vault's Approvals tab), a direct link, and when it expires (24 hours). |
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
| `AMBIGUOUS_ASSET` | Several different tokens share that symbol (look-alikes). Ask again with the chain and contract address, for example `near:kat.token0.near`. |
| `VAULT_CAP` | Public beta: the vault holds more than the beta limit ($100), so buys are paused. Sells still work. |

Tokenized markets trade around the clock, so there is no market-closed code; stock minimums vary with available liquidity.
