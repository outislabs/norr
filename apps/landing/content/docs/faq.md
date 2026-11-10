# FAQ

## Can my agent steal the money?

It holds one token, scoped to one vault, that can read the vault, get prices and request trades. It cannot withdraw, change rules, or choose where money goes: trades stay in the vault, and withdrawals go only to your whitelisted address with your approval. The most a misbehaving agent can do is make trades within your rules until you pause the vault or revoke its token.

## How do I get my money out?

Open the vault, then **Withdraw**. You pick the asset and an amount (or Max). The destination is your own signed-in NEAR account, shown and not editable, and it is the only account the vault's custody policy allows. Check first (nothing moves), then request: it waits in **Approvals** until you approve, with the same hash and match checks as a swap. The arrival at your account is public on NEAR. The agent has no tool for this. If the vault is in autonomous mode, Norr refuses to start a withdrawal until you turn it off in Rules, because the custody provider would then let it run without your signature.

## Does Norr hold my keys?

No. The vault's keys live in OutLayer's custody (in its enclave). The Norr service holds an API key for the vault's custody wallet, which is bounded by the limits you set in OutLayer. Custody is not trustless; see [Privacy model](/docs/privacy/).

## What if the Norr service is offline?

Nothing trades. Your funds stay in the custody wallet, and you can still withdraw through OutLayer's own dashboard to your whitelisted address. During the pilot the hosted service runs on demand.

## Which chains can I fund from?

USDC on NEAR, Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain or Solana, or ETH or SOL. It arrives as USDC in the vault's confidential balance. Funding with USDC on NEAR is proven on mainnet; the other chains were quoted live (USDC at about 0.01%, 20 to 45 seconds) but not yet funded with real money.

## Which wallets can I sign in with?

HOT Wallet (tested), and, not yet tested with Norr: Meteor Wallet, MyNearWallet, Intear Wallet, Nightly, Sender and Ledger. Each one implements NEP-413 message signing, which sign-in and approvals need; the sign-in picker marks the untested ones "(untested)". The picker always shows every wallet, and signing out forgets the wallet you used. If a wallet cannot start in your browser, the sign-in page says so.

## Do I need a NEAR wallet?

To own a vault, yes: sign-in is a NEAR signed message, and swap approvals are signed by your NEAR account, in Norr's Approvals tab. [HOT Wallet](https://hot-labs.org/wallet/) gives you a NEAR account next to your EVM and Solana ones. Funding can come from any listed chain.

## Why do I approve every swap?

On OutLayer, swaps and withdrawals share one transaction type, so approvals cannot be turned off for swaps without also turning them off for withdrawals. Keeping them is what guarantees the agent can never move money out. The Approvals tab shows what OutLayer will run next to what Norr asked for, checks the hash in your browser, and lets you approve or reject without leaving Norr.

## Which agents work?

Any MCP client: Claude Code, Claude Desktop (through `mcp-remote`), or your own. The repository includes a reference agent whose model runs on NEAR AI Cloud. See [Connect your agent](/docs/connect-agent/).

## What is the smallest trade?

Crypto: a few dollars. Tokenized stocks: the smallest order that quotes, about $5 on the most liquid tickers and $26 for others when measured; minimums vary with available liquidity.

## Can US persons trade stocks?

No. Ondo's tokenized stocks are offered to non-US persons only. You confirm non-US status before stocks are enabled. This is not legal advice.

## What does it cost?

Norr charges nothing in the pilot. Routes have their own costs: a $1.5 USDC to SOL round trip cost about 0.15%, and a $6 stock round trip about 1.2%.

## Is it audited?

No. It is a hackathon build, run with small balances. The code, tests and evidence are public: [github.com/outislabs/norr](https://github.com/outislabs/norr).
