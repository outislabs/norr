# Quickstart for owners

From an empty tab to an agent trading inside your rules. You need a NEAR account (any NEAR wallet; [HOT Wallet](https://hot-labs.org/wallet/) gives you one next to your EVM and Solana addresses) and the vault that has been set up for that account.

## 1. Sign in

Open [app.norr.finance](https://app.norr.finance) and choose **Sign in with a NEAR wallet**. Your wallet signs one message that names the dashboard ("Sign in to Norr at https://app.norr.finance"). Signing moves no funds and gives Norr no access to them.

**Vaults.** After signing in, **Vaults** lists the vaults that belong to your account.

**No vault yet?** Create one (public beta: up to $100, one vault per account):

1. Accept the [beta terms and risk disclosure](/docs/terms/), and optionally confirm you are not a US person (needed for stocks). Norr opens a custody wallet for you and seals its key in its enclave.
2. **Review the custody policy** Norr proposes: confidential operations only, money can only go to your own account, every operation waits for your approval, limits of about $10 per operation and $30 a day. Tick **Autonomous mode** only if you want swaps to run without your signature.
3. **Sign with your wallet.** One transaction to `outlayer.near` stores the policy, with about 0.02 to 0.04 NEAR of storage (yours, refundable). Because your account stores it, you become the policy's controller: only you can change or freeze it, never Norr.
4. Norr checks the chain and the custody provider, then activates the vault. Fund it and connect your agent.

## 2. Check the rules

Open the vault, then **Rules**. Start from a preset (Cautious, Balanced, Degen) and adjust: the largest single trade, the daily spending and loss caps, the share of the vault allowed in stocks, which assets the agent may trade, and the wait between trades. To enable tokenized stocks, confirm that you are not a US person. Details: [Rules and limits](/docs/rules/).

## 3. Fund the vault

Open **Fund**. Pick what you hold and where: USDC on NEAR, Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain or Solana, or ETH or SOL. Enter an amount in USD and your address on that chain (a refund goes there if the deposit cannot complete), then **Get a deposit address**.

- With a browser wallet on an EVM chain (MetaMask, Rabby), **Send with my wallet** switches the network and asks your wallet to send the exact amount. You confirm it in the wallet.
- Otherwise scan the QR code (on Solana it carries the amount) or copy the address.

The money arrives as USDC in the vault's **confidential** balance, usually within a minute. Funding with USDC on NEAR is proven on mainnet (1 USDC arrived exactly, 2026-10-31); the routes from other chains were quoted live on 2026-11-03 and have not yet been run with real funds. The destination is always your vault: the Norr service sets it, not the page. Your transfer itself is a normal public transaction on the chain you send from.

**If 1Click cannot quote** (it refused every deposit starting on NEAR on 2026-11-05), the Fund tab says so and, for USDC on NEAR, offers **Deposit directly on NEAR**: your wallet sends the USDC straight to the vault's account on NEAR Intents (`ft_transfer_call` to `intents.near`). That deposit is **public**: the sender, the vault's account and the amount are visible on chain. It shows under **Public balance**; tap **Move into the confidential layer** and approve the move in **Approvals**. The move stays inside the vault. Not yet run live.

## 4. Connect your agent

Open **Connect** and **Create an agent token**. The token is shown once. Paste the snippet for your client (Claude Code, Claude Desktop, or any MCP client) into its configuration. See [Connect your agent](/docs/connect-agent/).

Then ask the agent something like "What are my Norr rules?" and "Buy $40 of NVDA".

## 5. Watch, approve, stop

- **Activity** lists every request: done, refused (with the rule that refused it), or waiting for you. The agent's stated reasoning is sealed to your wallet; **Unlock reasoning** reads it with one signature.
- **Approvals.** Your custody provider (OutLayer) holds each swap until you approve it. **Approvals** shows the operation as OutLayer describes it next to what Norr asked for; your browser recomputes the hash you would sign, and **Approve** stays disabled unless both match. Your wallet signs the vote and your browser sends it straight to OutLayer. **Reject** is always available. You can still approve in OutLayer's own dashboard.
- **Pause everything** (top right) stops every vault at once. The agent's next request is refused with `PAUSED` until you resume.
- **Verify** checks, in your browser, that the service runs the published code in a genuine enclave. See [Verify the enclave](/docs/verify/).

## Try it without funds

The whole flow runs locally in mock mode: fixed prices, no network, nothing leaves your machine.

```
git clone https://github.com/outislabs/norr && cd norr
pnpm install
pnpm judge        # typecheck, every test, the demo through a real MCP client: PASS/FAIL per check
pnpm dev:mock     # the service on :8787; prints an agent token
pnpm dev:web      # the dashboard on http://localhost:5173, "Use the demo owner"
```
