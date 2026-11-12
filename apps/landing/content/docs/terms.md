# Beta terms and risk disclosure

Version 2026-11-04. You accept this version when you create a vault; the version and time are stored with your vault.

## What the beta is

Norr is experimental software, offered as a public beta. It lets an AI agent you choose trade from a custody wallet you
control, inside rules you set. It runs on mainnet with real money.

## Limits during the beta

- Up to **$100 per vault**. Norr refuses funding addresses past that, and pauses buys while a vault holds more.
- One vault per NEAR account.
- New vaults can be paused at any time. Vaults that already exist keep working.

## Who controls what

- **You.** Your NEAR account stores your vault's custody policy on chain, which makes you its controller. Only you can
  change or freeze that policy. Money can only be sent to your own account. Unless you chose autonomous mode, every
  operation waits for your approval.
- **Your agent.** It holds a token for one vault. It can read the vault, get quotes and trade within your rules. It
  cannot withdraw, change rules, or choose where money goes. You can revoke it at any time.
- **Norr.** The Norr service holds your vault's custody key inside an attested enclave and enforces your rules before
  every trade. It cannot change your custody policy.
- **OutLayer** (the custody provider) holds the wallet keys in its enclave and enforces your policy.

## Risks you accept

- **Loss of value.** Crypto and tokenized stocks can fall in price, fast. Your agent can make bad trades within your
  rules. Nothing here is investment advice.
- **Software risk.** Norr, OutLayer and NEAR Intents are new software and can have bugs.
- **Custody trust.** For swaps, OutLayer's gateway builds the route and deposit address and its enclave does not re-check
  the token or amount. Norr checks every result and pauses the vault on a mismatch, but a dishonest or compromised
  gateway can cause losses up to your limits. Custody is not trustless.
- **Autonomous mode.** If you turn it on, operations run without your signature within the limits. Withdrawals and
  transfers still go only to your own account.
- **Privacy has limits.** Deposits and withdrawals are private: they never name your vault. The custody provider and the
  NEAR Intents operator see confidential trades. See the [privacy model](/docs/privacy/) for what stays visible.
- **Availability.** The service can be offline. Your funds stay in your custody wallet, which you control through
  OutLayer, whether or not Norr is running.

## Tokenized stocks

Tokenized stocks are not available to US persons. Your agent can trade them only after you confirm that you are not a US
person. They are tokens issued by third parties (such as Ondo), not shares, and carry the issuer's own terms and risks.

## No warranty

Norr is provided as is, without warranty of any kind. To the extent the law allows, its authors are not liable for losses
from using it. Use only money you can afford to lose.
