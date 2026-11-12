# Privacy model

Private from the public is not private from everyone. This is who sees what.

| Data | Public chain observers | OutLayer (custody) | NEAR Intents operator and solvers | Norr service | You |
|---|---|---|---|---|---|
| A confidential swap: pair, size, price, balances | **Hidden** (confirmed on mainnet: no public balance change, no public transaction) | Sees all | Sees the intents | Sees all | Yes |
| Deposits and withdrawals | **Private: they never name your vault.** Your own wallet's transfer (amount, time) is visible | Sees all | Sees all | Sees all | Yes |
| That you have a vault | Tied to your account by the custody policy you store on chain | | | | Yes |
| Direct NEAR deposit (fallback) | **Public**: it sends straight to the vault's account | Sees all | Sees all | Sees all | Yes |
| The agent's stated reasoning | No | No | No | Writes it, **cannot read it back** | Only you |
| Decisions, counters, rules | No | No | No | Yes (it must, to enforce caps); encrypted on disk | Yes |
| The agent's model and prompts | No | No | No | No | Private if the model runs on NEAR AI Cloud; otherwise your agent host's own privacy |
| The code that enforces all this | Anyone can verify it | | | | |
| That the traffic comes from Norr | Not private: Norr's partner key identifies it to 1Click and OutLayer | | | | |

## How each part works

- **Confidential trades.** When the vault's funds are in NEAR's Confidential Intents layer, Norr quotes and trades there (`CONFIDENTIAL_INTENTS` deposit, recipient and refund types). Observers see no swap and no balance change. Under "confidential when possible", a trade falls back to the public layer only when the funds are not in the confidential layer; under "confidential only" it is refused instead (`PRIVACY_UNAVAILABLE`).
- **Deposits and withdrawals are private: they never name your vault.** A deposit goes to a one-time address that forwards it through NEAR Intents into the vault's confidential balance; a withdrawal leaves NEAR Intents through intermediate accounts and arrives in your own account. Traced on mainnet: the vault's account appears in none of these transactions.
  - *Visible on your wallet's side:* the amount and time of what you send or receive, so a deposit and a later withdrawal of similar size and timing can be matched.
  - *Your vault's existence:* the custody policy you store on chain (it keeps Norr from changing your limits) lists the vault, so anyone looking up your account can learn that you have one and which it is. Not its balance or trades.
  - *The direct NEAR deposit fallback is public:* when 1Click cannot quote, the Fund tab can send USDC straight to the vault's account. Sender, vault and amount are visible, and so is the later move into the confidential layer.
  - *Tested:* deposits of USDC on NEAR, and withdrawals to the owner. Deposits from other chains use the same 1Click route but have not been run with real funds.
- **Sealed reasoning.** The `reason` an agent gives is encrypted to a key derived from your wallet's signature (X25519 and AES-GCM). The service stores it but holds only the public half, so it cannot read it back. The dashboard derives the private half in your browser when you unlock.
- **The engine is attested.** The Norr service runs in an Intel TDX confidential VM. Anyone can check which code and images it booted ([Verify the enclave](/docs/verify/)). Attestation proves the code, not the secrets the VM was given; Phala's key service, which releases the VM's encrypted settings, is a trust assumption.
- **The dashboard.** Strict Content-Security-Policy: no third-party scripts, no inline code, no fonts from Google. The verifier and your session stay in the browser.

## What Norr does not claim

- Not invisible to the custody provider, the NEAR Intents operator or the Norr service: they see confidential trades in order to execute and check them.
- That nobody can tell you have a vault, or that your own deposits and withdrawals are invisible: your wallet's side and the custody policy are public (above).
- **The person who runs Norr (the operator) holds the key that encrypts Norr's stored data.** The production image has no shell and logs are private, so there is no ordinary way to read it, but with a copy of the data the operator could decrypt it, and could deploy changed code (attestation shows every deployed version; it does not prevent one). The operator cannot read your sealed reasoning, cannot change a self-serve vault's custody policy (you control it on chain), and cannot send money anywhere but your whitelisted account. Moving the key into the enclave is proposed, not built.
- Custody is not trustless. For swaps, OutLayer's gateway builds the route and deposit address, and its enclave does not re-check token or amount. Limits and approvals bind an honest gateway; Norr detects tampering afterwards. Funds can still be lost to a dishonest or compromised gateway, up to what your limits allow.

The observations behind this table, with dates and request ids: [docs/PRIVACY.md](https://github.com/outislabs/norr/blob/main/docs/PRIVACY.md).
