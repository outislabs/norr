# Aurora Intents: what it could give Norr, and what we propose (2026-11-02)

Question: let people on EVM chains and Solana use Norr without a NEAR wallet. Sources: Aurora's docs (`docs.intents.aurora.dev`) as read on 2026-11-02, and NEAR Intents' chain-support page. Nothing here has been run. Items the docs did not settle are marked **unverified**.

## What Aurora offers

| Product | What it is | Status in the docs |
|---|---|---|
| **Swap Widget** | React component, built on NEAR Intents, for cross-chain swaps inside an app. Packages `@aurora-is-near/intents-swap-widget` (you bring the wallet connection), `-standalone` (its own wallet modal, AppKit, 50+ wallets), plus `-evm`, `-solana`, `-stellar` plugins. An iframe embed also exists. | Public. Needs an API key from Intents Studio (the key is not secret; it can sit in a web page). Integrator fee is set per key: 60% to the integrator, 40% to Aurora, Aurora floor 10 bps (2 bps for stablecoins). |
| **Intents Connect** | A user signs one message from a wallet on one chain (the docs' example: a Solana wallet signs `raw_ed25519`), deposits to a given address, and NEAR Intents funds an intermediary account on the destination chain that runs the actions (the example supplies into Aave on Base). | API with `x-api-key`; the docs I read do not say "pre-release". A search snippet did say the widget is not yet public and API access is early access: the two disagree, so treat access as **unverified** until we try a key. |
| **Intents Deposits / Swap API** | "Users deposit from any chain and asset, your app receives funds on the target chain." | Not read in detail (**unverified**). |

NEAR Intents itself already accepts EVM (ERC-191) and Solana (ed25519) signatures, so wallets on those chains can sign intents natively.

## What stands in the way of "no NEAR wallet"

1. **The owner is a NEAR account.** Sign-in is a NEP-413 message plus an access-key check against that account. The sealed reasoning key is derived from the same wallet's signature.
2. **Approvals live in OutLayer.** Each swap is approved by the vault's owner in OutLayer's dashboard, which needs a NEAR login. We chose to keep approvals (FINDINGS.md, "Autonomy"), and that decision is what keeps the agent unable to move money. An EVM or Solana owner could not approve swaps without a NEAR identity behind the vault.
3. **Execution must stay on NEAR rails** (CLAUDE.md rule 3). Intents Connect's value is running actions on other chains (Aave on Base) through an intermediary account. That is the opposite of what Norr does, so it adds nothing to the trade path.

## Proposal

**A. Build: fund the vault from any wallet (EVM, Solana).** Today funding from another chain works, but the owner copies a deposit address and sends by hand. With Aurora's widget the owner connects MetaMask or Phantom, picks the token they hold, and the funds arrive as USDC in the vault, destination fixed by Norr, not chosen in the widget. This is a UX gain with no change to who can trade, approve or withdraw. Cost: Aurora's fee on top of the route (10 bps or more).
- Needs from you: an Intents Studio API key.
- To verify before building on it (**unverified**): that the widget can pin the destination account and token, and where the funds land (public Intents account or the confidential layer). If it cannot, use the Swap or Deposits API behind our own button.
- Test: a $1 to $2 mainnet funding from an EVM or Solana wallet. Each transaction waits for your explicit confirmation in the chat.
- Fallback if the widget does not fit: keep our own 1Click deposit address flow, which already supports any chain, and add a clear "send from any chain" explainer.

**B. Do not build now: sign in with an EVM or Solana wallet.** It would need an owner identity that is not a NEAR account, a NEAR-side owner anyway for OutLayer approvals, and a new sealed-reasoning key derivation. That is a rewrite of the trust model, not a feature, and it cannot be tested properly before Nov 14. State it as roadmap and as a known limitation: funding from any chain, owning a vault needs a NEAR account.

**C. Skip: Intents Connect for trading.** It runs actions on non-NEAR chains.

## Decisions (2026-11-02)
1. **A approved.** The owner supplies an Intents Studio key in `.env` (`VITE_AURORA_API_KEY`; public by design) and confirms each mainnet test transaction.
2. **B accepted as a documented limitation and roadmap item** (README). NEAR's Ethereum-wallets module (`@near-wallet-selector/ethereum-wallets` 10.1.4) does not implement `signMessage`/NEP-413, so it cannot replace our sign-in; whether OutLayer's approval screen accepts such an account was not found in any source.
