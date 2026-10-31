# Hosting and attestation options (researched 2026-10-31)

Question: with no Phala budget yet, where can Norr run, how much of the "verifiable" story survives, and what is the cheapest honest path? Everything below is from the vendors' own pages on the date above; where pages disagree, both figures are given and the dashboard is named as the arbiter. Nothing here has been run on these platforms.

## 1. OutLayer verifiable compute: not a home for the Norr service

What it is: off-chain functions compiled to **WebAssembly** (Rust recommended, `wasm32-wasip2`), run in an Intel TDX enclave, started per request. Each execution returns an attestation covering the SHA-256 of the exact WASM, the SHA-256 of the input and the output.

Why the service does not fit:
- **No server model.** Execution is request/response (`request_execution` on NEAR, or `POST /call/<owner>/<project>` with a payment key). There is no listening port, no long-lived process, no inbound HTTP handling. Norr is an HTTP service (Hono) with an MCP endpoint, a dashboard API and a polling loop for approvals.
- **Hard limits per execution:** 500 billion instructions, 180 seconds (default 60). Failed executions are not refunded.
- **State is a key-value API** (WASI P2 only), not files or a database. Norr's ledger and counters would have to be rebuilt on it.
- **Outbound network access from WASM is not documented**, and the service needs 1Click, the custody provider and DexScreener.
- **Language:** the service is TypeScript. Compiling it to WASM would mean a JavaScript-in-WASM runtime or a Rust rewrite.
- **Cost:** `base_fee + instructions x rate + time_ms x rate`, USDC via payment keys. The three rates are not published in the docs (use the `estimate_execution_cost` view method or the Stats page). No free tier is documented.

What OutLayer already gives us, and we already use: the custody wallet's policy engine (limits, whitelist, approvals) runs in its TEE. That is the hard backstop in the architecture.

A narrow possibility, not recommended now: a Rust port of the pure `evaluatePolicy` as an attested function. Its attestation would prove which logic produced an answer for the inputs it was given, not that the service asked it or obeyed it, so it adds little for the cost of a rewrite. Roadmap at most.

## 2. NEAR AI Cloud for the demo agent's model: yes, and cheap

- OpenAI-compatible API (a base URL and key swap), tool calling supported. Private models run in TEEs; the hardware-signed attestation on every response is **included in the per-token rate**, no platform fee. Pay as you go with no minimum; a spend cap can be set per API key. No free credits are mentioned on the pricing page.
- Verification: gateway attestation (`/v1/attestation/report`), model attestation, and a per-completion signature (`/v1/signature/{chat_id}`, over request and response hashes). A browser checker exists at `cloud.near.ai/verify`.
- Prices per million tokens (input / output), private TEE tier: Qwen 3.6 35B A3B FP8 $0.17 / $1.10; DeepSeek V4.1 Flash $0.30 / $1.20; GLM 5.3 Flash $0.08 / $0.50; Kimi K2.6 (3P TEE) $0.81 / $3.85.

Cost estimate for the demo (assumptions, not measurements: about 6,000 input and 600 output tokens per agent turn, 10 turns per run, 20 runs for rehearsals and the final take = 1.2M input, 0.12M output tokens):

| Model | Estimate |
|---|---|
| Qwen 3.6 35B A3B FP8 | about $0.34 |
| DeepSeek V4.1 Flash | about $0.50 |
| Kimi K2.6 | about $1.43 |

Budget $5 for everything including model trials. The real risk is not cost but tool-calling quality on the cheaper models, which needs a quick test.

What it needs from us: a small agent harness (OpenAI-compatible client plus an MCP client pointed at Norr's HTTP MCP endpoint, with a loop). Claude Desktop cannot use another provider's model. About 150 lines; the harness machine sees everything the agent does, so this makes the *model's* reasoning private and attested, not the whole agent.

## 3. Phala / dstack: free credit exists but is not reliably documented

- Pricing page: CPU instances have no subscription or minimum, billed for running minutes only. `tdx.large` (4 vCPU, 8 GB) about $0.232/h compute. **Stopped CVMs cost $0 compute; storage keeps billing at $0.000139 per GB-hour** (delete to stop it).
- Smaller instance: one Phala page lists `tdx.medium` at $0.069/h (about $50/month) and describes it as 1 vCPU / 2 GB / 40 GB; the docs describe `tdx.medium` as 4 vCPU / 8 GB. Check `phala instance-types` before assuming.
- Free credit: the pricing page says workspaces can receive **gifted credits** (amount not stated) and that **some workspaces are offered a welcome credit when they add a card** (the workspace shows the amount and what it can pay for before you claim it; once per workspace and card). Older posts say $400 and one free CVM, others $20; treat both as stale. The CLI guide mentions `npx phala free` for "a free CVM deployment"; the pricing page says legacy free CVMs are reclaimed six months after creation. I found no hackathon-specific Phala credits. The "Builders Challenge" posts are from 2025 and may be over.
- Account limit quoted as 8 CVMs / 16 vCPUs on one page and 16 CVMs on another; irrelevant at our size.

Arithmetic for the $50 cap if there is no credit: a `tdx.medium` run for the whole 14-day window is about $23; run only for rehearsal and judging (say 72 hours) it is about $5 plus a few dollars of storage. A `tdx.large` for 14 days is about $78, over budget.

## Recommendation

> **Update 2026-10-31:** the owner decided that Norr runs inside a TEE for the demo and for judging, so step 1 below (run outside a TEE) is not used, and step 3 (Phala) is the plan rather than an upgrade. Steps 2 and 4 stand: NEAR AI Cloud for the agent's model (measured in `AGENT-MODELS.md`), no OutLayer compute. The deployment plan, costs for about 72 hours and the checklist are in `FIRST-DEPLOY.md`. The research above is unchanged.

1. **Now, at $0: run the service outside a TEE and say so.** The Verify screen already reports "not running in a TEE" and the attestation endpoints answer 503 with that message; the README's limitations say the same. Keep the image digest and commit visible. Judges see an honest "not attested" rather than a claim.
2. **Spend the small money where the product story gains most: NEAR AI Cloud for the agent's model** (about $5 budget). It makes the agent's reasoning private and attested per request without Phala, and fits the Private AI track.
3. **Phala as an upgrade gated on free credit, decided about Nov 10.** Create the workspace and look at what the dashboard offers (gifted or welcome credit) before putting down a card for anything beyond that. If a credit covers roughly $10 or more, deploy the smallest instance that runs the service, only for rehearsal through judging, and stop it between sessions. If not, stay on step 1; the $50 cap would cover the run-only-when-needed plan anyway.
4. **Do not build on OutLayer compute** for the hackathon.

## Sources

- OutLayer: [NEAR docs](https://docs.near.org/primitives/off-chain-compute/outlayer), [getting started](https://app.outlayer.ai/docs/getting-started), [projects](https://app.outlayer.ai/docs/projects), [pricing and limits](https://app.outlayer.ai/docs/pricing)
- NEAR AI Cloud: [pricing](https://near.ai/pricing), [verification](https://docs.near.ai/cloud/verification)
- Phala: [pricing](https://cloud.phala.com/about/pricing), [CLI guide](https://docs.phala.network/phala-cloud/phala-cloud-user-guides/advanced-deployment-options/start-from-cloud-cli), [launch post](https://phala.network/posts/introducing-phala-cloud-pricing-affordable-secure-scalable)
- Hackathon: [Gate.com report](https://www.gate.com/en-us/news/detail/near-protocol-launches-hackathon-with-250k-prize-pool-starting-november-1-17905435)
