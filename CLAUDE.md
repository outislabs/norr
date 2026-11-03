# CLAUDE.md — Norr

> Working name: **Norr** (norr.finance). Swap the name everywhere if it changes.
> Built for the NEAR Hackathon (Nov 1–14, 2026). Solo builder: Kelvin. You (Claude Code) do the heavy lifting.

> **History & timeline:** we build the whole product in this repo and keep full history. Submissions open Nov 1 and close Nov 14, 23:59 UTC. Work done before Nov 1 (research and spike, including the funded OutLayer test on Oct 30) is disclosed in the README's "Timeline & disclosure" section; keep that section current, with dates.

## 1. What we're building

Norr is a **private trading layer for AI agents**. Any agent (Claude, ChatGPT, custom bots) connects through an **MCP server** and trades **crypto and tokenized US stocks/ETFs** (Ondo Stocks) across chains via **NEAR Intents**. It does this **privately by default**, and the agent never holds the keys to the user's funds.

Privacy is not a feature or a setting. It is the foundation, so every design choice below must keep it that way.

**Core promise:** give your AI money without giving it the keys, and without showing the world your strategy.

**Hackathon tracks:** Privacy & Private AI, Unstoppable DeFi, AI Security, Agent Economy.

## 2. Hard rules for Claude Code

1. **Never send a mainnet transaction without Kelvin's explicit confirmation in the chat.** Show each transaction first. NEAR Intents has no testnet, so real crypto swaps use tiny amounts ($1–5). Ondo equity quotes have a minimum of about $28, so the first live equity trade is the $30 NVDAon round trip (funded by Kelvin), then the $40 NVDA buy in the demo rehearsal (~Nov 11–12).
2. No secrets in the repo. Use `.env` (gitignored) plus `.env.example`.
3. **All execution goes through NEAR rails** (NEAR Intents / 1Click, Confidential Intents, NEAR accounts). Assets can live on any chain. No direct DEX routers and no non-NEAR execution (no Jupiter etc.). External *read-only* data (prices, risk signals) is fine.
4. The agent's credential must **never** be able to move funds out of the vault, change policy, or choose a destination address.
5. Never log plaintext balances, positions, policies or strategy prompts outside the enclave.
6. Every module ships with tests. AI judges will read the repo, so keep the code clean, typed, and documented.
7. **Never submit a swap without `min_amount_out`.** Every swap request carries a positive minimum output, taken from the enclave's own 1Click quote, and passes `requireSwapBounds` (`packages/core`) first. No exceptions, including tests and spikes. Caveat found in the live test: OutLayer's swap endpoint accepts but ignores the field (it uses its own 1% slippage quote), so the bound is not enforced there. Every swap is therefore also checked after execution with `verifyExecution`.
8. Verify API shapes against the live docs before coding (https://docs.near-intents.org, OpenAPI at https://1click.chaindefuser.com/docs/v0/openapi.yaml). Install the NEAR skill: `npx skills add near/agent-skills --skill near-intents`.

## 3. Architecture

```
 AI agent (Claude / ChatGPT / bot)
        │  MCP (agent API token, scoped to ONE vault)
        ▼
 ┌──────────────────────────── ENCLAVE (TEE) ────────────────────────────┐
 │  norr-core                                                            │
 │   ├─ auth        agent tokens + owner sessions (NEAR signed message)  │
 │   ├─ registry    unified asset list (crypto + equity) from 1Click     │
 │   ├─ risk        crypto: scam/rug checks · equity: eligibility+price  │
 │   ├─ policy      per-vault rules, enforced before every trade         │
 │   ├─ executor    1Click quote → sign transfer → poll status           │
 │   ├─ custody     OutLayer wallet per vault (keys in its TEE, via API) │
 │   ├─ ledger      encrypted activity log (owner-readable only)         │
 │   └─ attest      exposes TEE attestation + code hash                  │
 └───────────────────────────────────────────────────────────────────────┘
        │                                   │
        ▼                                   ▼
 NEAR Intents / 1Click API            NEAR accounts (vaults)
 (Confidential Intents where supported)

 Owner dashboard (web) ── signs in with NEAR wallet ── talks to enclave API
```

### Custody model

> **Decision, locked 2026-10-30 (see `docs/ARCHITECTURE.md` and the funded test in `docs/FINDINGS.md`).** Keys, signing and the hard backstop policy live in **OutLayer Agent Custody**. The **Norr service**, hosted on **Phala dstack**, adds everything else. Nothing in `packages/core` depends on OutLayer. Fallback if a later test fails: Phala + Shade Agents with our own keystore.

- Each Norr vault = one **OutLayer wallet** (default master). The Norr service holds that wallet's API key; the AI agent holds **only a Norr agent token**, scoped to one vault.
- **OutLayer enforces (in its TEE):** capabilities, per-token limits, address whitelist, approval threshold, freeze. The **owner** sets this policy in OutLayer's dashboard; neither the agent nor the Norr service can change it.
- **Norr enforces:** asset registry and multi-issuer routing, Scam Shield, Shield incident feed, equity eligibility, the private per-vault policy, the private activity log and strategy, the MCP interface, and a post-trade `verifyExecution` against Norr's own 1Click quote (mismatch trips the kill switch).
- Withdrawals stay **approval-gated and whitelisted to the owner**, so the agent can never choose a destination. Working balances stay small and sit inside NEAR Intents.
- **Limit orders are out of v1 (known limitation):** two $1.50 marketable limit orders on OutLayer (about 0.5% and 4% above market) never filled; the policy has `limit_order` removed. Revisit only with evidence of reliable fills at larger size.
- **Trust assumption (state it in the README):** for swaps, OutLayer's gateway builds the route and deposit address and its TEE does not re-check token or amount. Limits and approvals bind an honest gateway; Norr detects tampering after the fact. `min_amount_out` is accepted but ignored by OutLayer's swap endpoint.

### Privacy model
| Data | Where it lives | Who can see it |
|---|---|---|
| Strategy prompts / agent reasoning | Enclave memory, encrypted at rest | Owner only |
| Policy rules | Enclave, encrypted | Owner only |
| Activity log | Enclave, encrypted per owner | Owner only |
| Vault keys | OutLayer TEE wallet | Nobody (OutLayer's gateway sees every operation) |
| Trades | Confidential Intents where supported | Minimised onchain footprint |
| Code integrity | Attestation endpoint (public) | Anyone can verify |

## 4. Day-1 gating checks (resolve before building on assumptions)

Record the findings in `docs/FINDINGS.md`.

1. **Assets:** call `GET /v0/tokens` and confirm the Ondo stock/ETF assets are routable via the 1Click API. Record their asset IDs.
2. **Confidential Intents:** confirm what it hides (amounts, balances, counterparties), whether quotes support `CONFIDENTIAL_INTENTS` deposit/recipient types for both crypto and equities, and how signed transfer intents work.
3. **TEE hosting:** confirm how to run a container in NEAR AI Cloud's TEE (or the alternative listed in the hackathon resources), how attestation is exposed, and how keys and data get sealed or persisted.
4. **Equity eligibility:** what apps connected to NEAR Intents must enforce or display for Ondo assets (country restrictions, disclaimers).
5. **1Click API key:** obtained from https://partners.near-intents.org (avoids the 0.2% fee).

If a check fails, stop and propose a fallback to Kelvin before continuing.

## 5. Repo layout

```
norr/
├─ CLAUDE.md
├─ README.md                 # written for judges (human + AI) — see §10
├─ docs/
│  ├─ FINDINGS.md            # day-1 gating results
│  ├─ ARCHITECTURE.md
│  └─ DEMO.md                # exact demo script
├─ packages/
│  ├─ core/                  # pure TS logic: registry, risk, policy, types (no I/O)
│  ├─ intents/               # 1Click client + signing helpers (NEAR)
│  └─ shared/                # zod schemas, shared types
├─ apps/
│  ├─ enclave/               # HTTP service that runs in the TEE (Hono or Fastify)
│  ├─ mcp/                   # MCP server (stdio + streamable HTTP), thin proxy to enclave
│  └─ web/                   # owner dashboard (Vite + React + Tailwind)
├─ scripts/                  # create-vault, fund, smoke-swap (all require --confirm-mainnet)
└─ .env.example
```

Stack: TypeScript everywhere, pnpm workspaces, zod for validation, vitest for tests, near-api-js (or the current NEAR JS SDK) for accounts and signing, and the 1Click TS SDK if it fits.

## 6. Data model (zod schemas in `packages/shared`)

```ts
type AssetClass = "crypto" | "equity";

interface Asset {
  id: string;            // 1Click asset id, e.g. "nep141:..."
  symbol: string;        // "NVDA", "SOL", "USDC"
  name: string;
  class: AssetClass;
  chain: string;
  decimals: number;
}

interface Policy {
  vaultId: string;
  maxTradeUsd: number;
  dailySpendCapUsd: number;      // total buys per UTC day; stops a big trade being split into small ones
  dailyLossCapUsd: number;
  maxEquityPct: number;          // max % of vault value in equities
  allowedCrypto: string[] | "any_safe"; // "any_safe" = anything passing risk checks
  allowedEquities: string[];     // tickers
  cooldownSec: number;
  paused: boolean;               // kill switch
  nonUsConfirmed: boolean;       // owner confirmed non-US status; equities blocked (INELIGIBLE) without it
  allowMediumRisk: boolean;      // medium Scam Shield verdicts pass only if true
  privacy: "public" | "prefer" | "require"; // prefer (default) = trade in the confidential layer whenever the vault holds the funds there; require = never fall back to public
}

interface TradeRequest {
  vaultId: string;
  side: "buy" | "sell";
  asset: string;                 // symbol or asset id
  amountUsd: number;
  reason: string;                // agent's stated reasoning (kept private)
}

type Decision =
  | { status: "executed"; txRef: string; filled: { asset: string; amount: string; priceUsd: number };
      venue?: "public" | "confidential"; verification?: "independent" | "custody-reported" }
  | { status: "blocked"; code: BlockCode; message: string }   // plain-language reason for the agent
  | { status: "pending_approval"; requestId: string; message: string }  // custody policy needs an owner signature
  | { status: "failed" | "refunded"; message: string };

type BlockCode =
  | "PAUSED" | "OVER_TRADE_LIMIT" | "DAILY_LOSS_CAP" | "COOLDOWN"
  | "ASSET_NOT_ALLOWED" | "EQUITY_LIMIT" | "SCAM_RISK" | "INELIGIBLE"
  | "PRICE_SANITY" | "UNKNOWN_ASSET" | "NO_LIQUIDITY" | "SHIELD_INCIDENT"
  | "DAILY_SPEND_CAP" | "PRIVACY_UNAVAILABLE" | "PRICING_UNAVAILABLE";
```

Tokenized markets trade 24/7, so there is no market-closed code. A quote failing with "No liquidity" maps to `NO_LIQUIDITY`.

**Multi-issuer routing:** an agent asks for a ticker (e.g. `NVDA`). The registry maps it to every routable version (Ondo `NVDAon`, xStocks `NVDAx`, …) and the enclave picks the best quote across issuers. Only issuers actually returned by 1Click are used (see `docs/FINDINGS.md`).

## 7. The trade pipeline (`apps/enclave`)

Every `trade` call runs these steps in order, and any failing step returns `blocked` with a clear message:

1. **Auth:** the agent token maps to exactly one vault.
2. **Resolve asset:** look it up in the registry. If it's unknown, block (`UNKNOWN_ASSET`).
3. **Risk:**
   - *crypto:* the scam/rug check (see §8). High risk → `SCAM_RISK`.
   - *equity:* the eligibility check, plus a price sanity check of the quote against a reference price (deviation > X% → `PRICE_SANITY`).
4. **Policy:** paused, per-trade size, daily spend cap (buys only, counted when the swap is sent and given back if it did not run), daily loss, cooldown, allowlists, equity %. Trades for one vault run one at a time, so parallel requests cannot slip past a cap.
   Then the NEAR Intents Shield incident feed (`shield.chaindefuser.com/incident`), last, for trades that pass the rules: an active incident touching the asset blocks with `SHIELD_INCIDENT` (fails closed if the feed is unreachable). A trade that breaks a rule is refused with that rule's reason (order changed 2026-11-03).
5. **Quote:** the enclave requests a 1Click quote itself, per venue, in the order the vault's `privacy` mode allows: **confidential first** (`CONFIDENTIAL_INTENTS` types) when the vault holds the funds in the confidential layer, public only as a fallback (never under `require`, which blocks with `PRIVACY_UNAVAILABLE`). Recipient and refund are always the vault.
6. **Execute:** the enclave signs the transfer to the quote's deposit address, then submits the deposit.
7. **Track:** poll status until `SUCCESS` / `FAILED` / `REFUNDED`.
8. **Verify:** public swaps are compared with the enclave's own 1Click quote using 1Click's independent status (`verifyExecution`). Confidential swaps have no independent source, so they are checked from confidential balances read before and after plus the provider's own report (`verifyConfidentialSwap`), and the result is labelled `custody-reported`. On any mismatch, trip the kill switch and alert the owner. This guards against the custody provider's coordinator tampering with a route (see `docs/FINDINGS.md`).
9. **Log:** write an encrypted ledger entry, update the daily P&L used by the loss cap.

Policy and risk logic live in `packages/core` as **pure functions**, so they can be unit-tested exhaustively.

## 8. Scam Shield (crypto) v1

The risk provider sits behind a pluggable `RiskProvider` interface, so it can later be swapped for richer data.

v1 heuristics, each returning a scored reason:
- not routable via 1Click → block;
- low liquidity / tiny market cap (from a read-only price source);
- very new token;
- known stablecoins and majors are allowlisted.

Output: `{ score: 0-100, level: "low"|"medium"|"high", reasons: string[] }`. High → block, medium → allowed only if the policy opts in.

## 9. MCP server (`apps/mcp`)

The tools are thin wrappers over the enclave API. Their descriptions are written so agents use them well:

| Tool | Purpose |
|---|---|
| `list_assets` | Tradable assets, filterable by class (crypto / equity) |
| `check_asset` | Risk or eligibility verdict for an asset, with reasons |
| `get_quote` | Dry-run price for a trade (no funds move) |
| `trade` | Request a trade; returns executed / blocked (with reason) / failed |
| `get_portfolio` | The vault's holdings and value, split by asset class |
| `get_policy` | The rules the agent must stay within (so it can plan) |
| `get_activity` | The vault's recent decisions |

Support stdio (Claude Desktop / Claude Code) and streamable HTTP (remote agents).

## 10. Owner dashboard (`apps/web`)

Built by Claude Code (no Lovable). Vite + React + Tailwind, mobile-first.

Screens:
- **Sign in** with a NEAR wallet (signed message → enclave session).
- **Vaults:** create a vault, fund it, issue or revoke an agent token, and copy the MCP config snippet.
- **Rules:** edit the policy (with sensible presets: Cautious / Balanced / Degen).
- **Activity:** an executed / blocked / failed timeline, with the agent's private reasoning visible to the owner.
- **Kill switch:** one tap pauses every vault.
- **Verify:** shows the enclave attestation and code hash.

Design direction: discreet and private, more "a private bank's vault room at night" than "neon crypto casino." Follow the frontend-design guidance: deliberate palette and typefaces, no generic SaaS card kit. Avoid the defaults of near-black with a single acid-green accent and all-caps labels.

## 11. Build plan (Oct 30 to Nov 14)

Locked decisions and every finding are in `docs/ARCHITECTURE.md` and `docs/FINDINGS.md`. Key findings: OutLayer's swap ignores `min_amount_out` (so `verifyExecution` after every swap is mandatory); swap routes are built by OutLayer's gateway and not re-verified by its TEE; limit orders did not fill (out of v1); equity quotes work through OutLayer but equity execution is untested; Ondo has a ~$28 minimum; the first live swap round trip cost 0.15%.

| # | Deliverable | Done when |
|---|---|---|
| 1 | Norr service: OutLayer integration, swap guard, `verifyExecution`, Scam Shield, Shield feed, eligibility, daily spend cap, **mock mode** | Done: 238 tests, runs with no funds |
| 2 | MCP server (stdio + streamable HTTP) | Done in mock mode; tested with Claude Desktop |
| 3 | **First live Confidential Intents trade** through OutLayer (small, from the existing balance), then fund the vault confidentially | A confidential swap executed and its limits written up honestly in `docs/PRIVACY.md` |
| 4 | $30 NVDAon equity round trip (Kelvin funds it), confidentially if step 3 works | Buy and sell back checked with `verifyExecution`; result in FINDINGS |
| 5 | Owner dashboard: vaults, rules, activity with agent reasoning, kill switch, verify screen, request-vs-approval mismatch check | **First version built** (`apps/web`, owner API in the enclave); remaining: funding screen, real-wallet sign-in check, visual review on a phone |
| 6 | Privacy layer: encrypted owner-only reasoning and log; Phala deploy + attestation; autonomous mode with its own demo-vault policy | Attestation verifiable from outside; swaps skip approval within tight limits, withdrawals stay gated |
| 7 | If time: private strategy agent on IronClaw (unverified), Follow, Aurora Intent Connect | Only after 1-6 are solid |
| 8 | Demo rehearsal (~Nov 11-12), README for AI judges (with the privacy table), demo video, X post draft, submission payload | Rehearsal runs clean 3 times; payload approved by Kelvin before sending |

Submissions close Nov 14, 23:59 UTC; aim to submit with at least a day of buffer.

### Autonomous mode (demo) — build plan
For the demo the agent must trade without a human signature per swap, while money can still only leave to the owner.
- **OutLayer policy for the demo vault:** swaps (and limit orders, if proven) skip approval via the policy's approval exclusions, inside tight limits (per-trade at most the Norr max trade of $50, a small daily cap, a rate limit, a small vault balance of about $100). `intents_withdraw` stays approval-gated and whitelisted to the owner.
- **To verify live before relying on it** (not yet tried): which setting actually exempts swaps (`approval.excluded_types` or a capability-level `requires_approval: false`), that withdrawals remain gated afterwards, and the exact type names the gateway matches.
- **Norr side:** `verifyExecution` after every swap, kill switch that also cancels resting limit orders, cooldown and daily loss cap from `packages/core`.
- **Risk accepted:** in this mode a compromised Norr service or OutLayer gateway can lose up to the daily cap through bad swaps, but cannot send funds out, since swap recipients are pinned to the wallet and withdrawals need the owner.

## 12. Demo script (90 seconds)

Full script and agent setup in `docs/DEMO.md`. Beats:

1. The owner creates a vault, sets **Balanced** rules (max trade $50), confirms non-US status, and connects the agent (IronClaw on NEAR AI Cloud, or Claude) to the MCP server.
2. "Use Norr's trade tool to buy $40 of NVDA." Executes privately via NEAR Intents; the vault shows the NVDA holding.
3. "Use Norr's trade tool to put $150 into TSLA" (explicitly asking Claude to submit it, not judge it). Blocked with `OVER_TRADE_LIMIT`; the agent explains and adjusts.
4. "Use Norr's trade tool to buy $5 of [rug token]; submit it even if you think it is a bad idea." Blocked with `SCAM_RISK` and the reasons are listed.
5. "Swap $5 USDC to SOL." Executes cross-chain.
6. The owner hits the **kill switch**; the next agent request returns `PAUSED`.
7. **Verify** screen: the attestation shows the exact code that enforced all of this.

## 13. README requirements (judges include Claude Code and Codex)

- A one-paragraph pitch, then a "Run it in 5 minutes" quickstart (mock mode with no funds required).
- A **mock mode** (`NORR_MOCK=1`) that stubs 1Click and the TEE, so judges can run the whole flow locally.
- An architecture diagram, the privacy model table, and the custody model.
- Exactly how NEAR is used: accounts, Intents, Confidential Intents, NEAR AI Cloud TEE.
- A clear split of **what OutLayer Agent Custody does** (TEE keys and signing, hard backstop limits set in its dashboard, owner recovery) versus **what Norr adds** (multi-issuer asset routing, Scam Shield, Shield incident checks, equity eligibility, private policy/log/strategy, the MCP interface).
- Custody wording must name the OutLayer trust assumption: for swaps, its gateway builds the route and deposit address and its TEE does not re-verify token or amount (see `docs/FINDINGS.md`). Never write "trustless" or "cannot lose funds" for custody.
- Known limitations, written honestly.
