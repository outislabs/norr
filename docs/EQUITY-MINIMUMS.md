# Small tokenized-stock orders: what the minimum really is

Measured with free dry quotes only (`dry: true`; no funds, no deposit addresses). Tool: `scripts/research/equity-min-map.py`. Dates and times matter, so every result carries one.

## Headline
There is no single "$28 minimum". There are two different floors, and one of them moves:

| Group (buys, USDC on NEAR to the Ondo token) | Floor on Fri 2026-10-30 ~15:30Z (US market open) | Floor on Sat 2026-10-24 ~10:30Z |
|---|---|---|
| NVDAon, TSLAon, AAPLon, QQQon, AMZNon, GOOGLon (confidential route) | **about $5.05** ($5.00 fails, $5.05 quotes) | not measured; NVDAon needed $28 (the $25 grid point failed) |
| SPYon, CRCLon, METAon (confidential) | quote from $5.25 but with gaps at $8-$25 | |
| MSFTon, INTCon, HOODon, TLTon, BRAINon, YLD5on (confidential) | **$26** (a clean step: $25 fails, $26 quotes) | |
| Same tickers on the public route | Erratic: for example NVDAon quotes at $9 and $10 but not at $12; TSLAon at $6 but not at $7-$9 | NVDAon needed $28 |
| USDon (a $1 token) | never quotes | |

Sells are different and more forgiving: **in the confidential route every ticker tested, including MSFTon, quotes from $5.25** (so a small position can be exited); below about $5 nothing quotes.

## What I tested
- 13 tickers x sizes $5-$30 x public and confidential (USDC on NEAR as the input).
- 4 liquid tickers x $5-$12 x 4 repeats x both routes. Results were identical across repeats within a minute; I then used odd amounts ($5.25, $5.5, $6.01, $6.37, $7.13) to rule out a per-amount quote cache: the confidential results held.
- Bisection of the liquid-ticker floor: $5.00 fails, $5.05, $5.10, ... $5.25 all quote.
- Other input assets and routes to NVDAon (public unless noted): SOL held in Intents quotes from $6 (cost about 0.8%); wNEAR from $6 (about 1.3%); USDC sent direct from BSC from $6 (0.37%); USDC from Ethereum from $10; USDC on NEAR to a BSC wallet from $20; **USDC or USDT on BSC held in Intents only from $20**; USDC on NEAR through the confidential route from $5.05 (about 0.15% cost, the cheapest).
- Sells of NVDAon, TSLAon, AAPLon, MSFTon at $2-$30, both routes.

## What causes it
Evidence is behavioural; I have no view into the solvers, so these are hypotheses ranked by how well the data fits:
1. **Two liquidity paths with different minimums (best fit).** The tickers split cleanly into a roughly-$5 group and a $26 group, and the $26 step is exact. The Saturday result ($25 fails, $28 quotes, for tickers that now quote at $5.05) fits a world where only the $26-style path was available on the weekend and the lower one is there during US market hours. The re-run after hours and on a weekend is what would confirm this; the script exists for that.
2. **Solver participation by size window.** On the public route the answer flips with the amount (NVDAon: $9, $10 yes; $12 no), which looks like individual market makers quoting only some sizes. The confidential route used a stabler set.
3. **A minimum order notional of about $5 on the Ondo path**, because nothing quotes below it, even for deep tickers and on sells. Ondo's own press coverage says its minimum is $1, so this is not (only) the issuer.
4. **Not the cause:** cross-chain cost (BSC-native routes and SOL/wNEAR inputs have floors of $6-$20, never lower than the USDC-on-NEAR confidential route), and not a general Intents limit (a $1.50 USDC to SOL swap quotes fine).

## Other issuers and routes
Searched the live token lists (210 plain, 238 with `?ondoTokens=true`), including the Robinhood chain (`hood`) tokens, and the web. NEAR Intents carries **only Ondo** stocks and ETFs: 28 tokens, all on BSC. No xStocks, Dinari or other tokenized-equity assets are listed, and no source I found says they are planned. Buying on a BSC exchange directly would be outside NEAR rails, which the project rules forbid.

## What this means for Norr
- **$5 NVDA or TSLA is possible, with a $5.10 floor.** An order of exactly $5.00 fails by five cents. Product choice: treat the smallest stock order as $5.10 for the liquid group and say so, instead of showing a generic "no liquidity".
- **For MSFT-style tickers the floor is $26 on buys**, but any size above about $5 can be sold.
- **Dust cannot be sold.** A position that has fallen below about $5 (or a remainder left after a partial sell) will not quote. Norr should warn before a sell leaves a remainder under $5.10, and prefer selling everything.
- **Confidential beats public here:** it quotes more reliably and costs less (about 0.15-0.4% against 0.2-0.4%, with a few unexplained 0.00% outliers on public SPYon).
- **Funding the NVDA test:** a $6 round trip on NVDAon in the confidential route would be quotable today, so a $31 top-up is no longer needed to prove it; $8-$10 would do. Quotes are not fills, so the first real one is still the proof.
- **Suggested code change (not built):** when an equity trade returns no liquidity, probe a short ladder of larger sizes with free dry quotes and tell the agent the smallest size that quotes right now.

## Question for the NEAR Intents team (draft, ready to send)
> Hi NEAR Intents team. We're building an agent trading layer on 1Click and Ondo assets. Dry quotes for USDC (NEAR) to Ondo tokens on Fri 2026-10-30 ~15:30Z: NVDAon, TSLAon, AAPLon, QQQon, AMZNon and GOOGLon quote from about $5.05 on `CONFIDENTIAL_INTENTS` routes, but MSFTon, INTCon, HOODon, TLTon and BRAINon only from $26; on the public `INTENTS` route quotes come and go with the amount (NVDAon quotes at $9 and $10 but not $12). On Sat 2026-10-24 ~10:30Z NVDAon needed at least $28. Sells quote from about $5.25 for all of them. Could you tell us: (1) Is there a documented minimum order size for Ondo assets through 1Click, and is it set by the protocol, the solvers or Ondo? (2) Why do the two ticker groups differ ($5 vs $26), and does the floor depend on US market hours or weekends? (3) Why are public-route quotes non-monotonic in amount while confidential ones are stable? (4) Positions under about $5 can't be sold ("No liquidity available"); is that expected? (5) Could the quote API return a specific minimum-amount error instead of the generic "No liquidity available"?

## Built from these findings (2026-10-30)
- `list_assets` shows each stock's `minimumUsd` ($5.10 for NVDA, TSLA, AAPL, QQQ, AMZN, GOOGL; $26 for the rest) with a note that it can be higher outside US market hours; `get_quote` shows `statedMinimumUsd`.
- When a stock trade finds no liquidity, Norr probes larger sizes with free dry quotes (up to the vault's per-trade limit) and returns `NO_LIQUIDITY` with `suggestedUsd`, the smallest size that quotes right now, or says honestly that none does.
- Sells that would leave a remainder under $5.10 return a `warnings` entry (in `get_quote` and in the result); they are not blocked.
- The numbers are a static table (`packages/core/src/equity-minimums.ts`) from one afternoon of measurements. The scheduled re-runs (`scripts/research/run-at.sh`, results in `docs/research/`) are what should update it.

## Re-running
`set -a; . ./.env; set +a; python3 scripts/research/equity-min-map.py --venue both` at different hours and on a weekend; compare with the table above and update this file.
