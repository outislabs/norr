# Privacy model

Private from the public is not private from everyone. This is who sees what.

| Data | Public chain observers | OutLayer (custody) | NEAR Intents operator and solvers | Norr service | You |
|---|---|---|---|---|---|
| A confidential swap: pair, size, price, balances | **Hidden** (confirmed on mainnet: no public balance change, no public transaction) | Sees all | Sees the intents | Sees all | Yes |
| Funding and withdrawing the vault | **Visible**: a public transfer from your address, on the chain you send from | Sees all | Sees all | Sees all | Yes |
| The agent's stated reasoning | No | No | No | Writes it, **cannot read it back** | Only you |
| Decisions, counters, rules | No | No | No | Yes (it must, to enforce caps); encrypted on disk | Yes |
| The agent's model and prompts | No | No | No | No | Private if the model runs on NEAR AI Cloud; otherwise your agent host's own privacy |
| The code that enforces all this | Anyone can verify it | | | | |
| That the traffic comes from Norr | Not private: Norr's partner key identifies it to 1Click and OutLayer | | | | |

## How each part works

- **Confidential trades.** When the vault's funds are in NEAR's Confidential Intents layer, Norr quotes and trades there (`CONFIDENTIAL_INTENTS` deposit, recipient and refund types). Observers see no swap and no balance change. Under "confidential when possible", a trade falls back to the public layer only when the funds are not in the confidential layer; under "confidential only" it is refused instead (`PRIVACY_UNAVAILABLE`).
- **Funding lands confidential.** A deposit from any chain is routed into the vault's confidential balance. The transfer you send is public on its own chain.
- **Sealed reasoning.** The `reason` an agent gives is encrypted to a key derived from your wallet's signature (X25519 and AES-GCM). The service stores it but holds only the public half, so it cannot read it back. The dashboard derives the private half in your browser when you unlock.
- **The engine is attested.** The Norr service runs in an Intel TDX confidential VM. Anyone can check which code and images it booted ([Verify the enclave](/docs/verify/)). Attestation proves the code, not the secrets the VM was given; Phala's key service, which releases the VM's encrypted settings, is a trust assumption.
- **The dashboard.** Strict Content-Security-Policy: no third-party scripts, no inline code, no fonts from Google. The verifier and your session stay in the browser.

## What Norr does not claim

- Not invisible to the custody provider, the NEAR Intents operator or the Norr service: they see confidential trades in order to execute and check them.
- A funding transfer and the next confidential hop can be correlated by timing and amount.
- Custody is not trustless. For swaps, OutLayer's gateway builds the route and deposit address, and its enclave does not re-check token or amount. Limits and approvals bind an honest gateway; Norr detects tampering afterwards. Funds can still be lost to a dishonest or compromised gateway, up to what your limits allow.

The observations behind this table, with dates and request ids: [docs/PRIVACY.md](https://github.com/outislabs/norr/blob/main/docs/PRIVACY.md).
