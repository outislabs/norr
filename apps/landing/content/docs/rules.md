# Rules and limits

Two layers of limits protect a vault. Norr's rules are checked before every trade; the custody provider's own limits sit underneath and neither the agent nor Norr can change them.

## Norr's rules (you set them in Rules)

| Rule | What it does |
|---|---|
| Largest single trade | Any trade above it is refused (`OVER_TRADE_LIMIT`). |
| Daily spending cap | Total buys per UTC day. Counted when the swap is sent and given back if it did not run. |
| Daily loss cap | Once realized losses today reach it, buying stops; selling still works. |
| Stock share | The most of the vault's value that may sit in tokenized stocks. |
| Crypto allowed | Either "anything that passes the risk check", or a list of symbols. |
| Stocks allowed | A list of tickers. |
| Allow medium-risk tokens | Off by default. High-risk tokens are always refused. |
| Wait between trades | A cooldown in seconds. |
| Privacy | Confidential when possible (default), confidential only, or public only. |
| Non-US confirmation | Required before any stock trade (`INELIGIBLE` without it). |
| Paused | The kill switch; refuses every request. |

Trades for one vault run one at a time, so parallel requests cannot slip past a cap.

## Presets

| | Cautious | Balanced | Degen |
|---|---|---|---|
| Largest trade | $25 | $50 | $200 |
| Daily spending cap | $50 | $150 | $600 |
| Daily loss cap | $10 | $25 | $100 |
| Stock share | 20% | 60% | 100% |
| Crypto | BTC, ETH, SOL, NEAR, USDC, USDT | anything that passes the risk check | anything that passes the risk check |
| Stocks | SPY, QQQ | NVDA, TSLA, AAPL, MSFT, GOOGL, AMZN, META, SPY, QQQ | Balanced plus CRCL, HOOD |
| Medium-risk tokens | no | no | yes |
| Wait between trades | 5 minutes | 10 seconds | none |

No preset confirms non-US status; you do that yourself.

## Safety checks on every trade

In this order: Scam Shield (crypto) or eligibility (stocks), then your rules, then the incident feed. A trade that breaks one of your rules is refused with that rule's reason; only trades that pass every rule reach the feed.

- **Scam Shield (crypto).** Scores read-only market data from DexScreener (liquidity, market cap, token age) and contract checks from GoPlus Security: a honeypot, live mint or freeze authority, owner privileges (changing balances, blacklisting, pausing, minting, changing the tax) unless ownership is renounced for good, a hidden owner, self-destruct, buy and sell taxes above 10%, closed-source code. Tokens on GoPlus's trusted list are not penalised for privileges their issuer keeps (a stablecoin's mint authority). Known stablecoins and majors are allowlisted; anything not routable through NEAR Intents is high risk. A token GoPlus cannot check (NEAR-native tokens, no data, GoPlus unreachable) gets a stated reason and a little extra risk, never a silent pass. 65 or more is high (refused), 35 to 64 medium (refused unless you allow it). Unknown data counts as risk, so it fails closed. It is a set of heuristics, not a guarantee. Owners can run the same check in the dashboard (Rules, Check a token).
- **Incident feed (optional, a deployment setting).** With a NEAR Intents partner key configured, an active security incident touching the asset blocks the trade, and a feed that cannot be read blocks every trade (fail closed). Without a key there is no feed to check: the step is skipped, every other check still runs, and every answer says "Incident feed: not configured (partner key pending)". The hosted service has no key yet. NEAR Intents publishes no keyless incident or status signal.
- **Price sanity (stocks).** A stock quote more than 2% from the reference price is refused.
- **Minimum output.** Every swap carries a positive minimum taken from Norr's own quote, and the result is checked afterwards against that quote. A mismatch, or a result that cannot be checked, pauses the vault; the dashboard shows it paused until you resume.

## Tokenized stocks

Stocks and ETFs are Ondo's (and other issuers') tokens: structured notes that track the underlying security, with no shareholder rights, offered to non-US persons only. Norr asks for the ticker and routes to the best-priced issuer. The smallest order that quotes moves with the market: about $5 on the most liquid tickers at US market open, $26 for others, higher outside market hours. `list_assets` shows the current floor.

## The custody provider's limits (set in OutLayer)

Your vault is an OutLayer custody wallet. In OutLayer's own dashboard you set per-token limits, an address whitelist for withdrawals, an approval threshold, and a freeze. Withdrawals go only to your whitelisted address and need your approval, so the agent can never choose a destination. On OutLayer, swaps and withdrawals share one transaction type, so each swap also needs your approval, which you give in Norr's Approvals tab.
