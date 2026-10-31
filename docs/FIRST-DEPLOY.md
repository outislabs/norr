# First deploy to Phala Cloud: checklist

Decision (2026-10-31): Norr runs **inside a TEE** for the demo and for judging. No outside-TEE hosting. The CVM runs only when needed (about 72 hours in total) and is stopped otherwise.

Everything here is read from the CLI's own help (`phala` 1.1.22) and Phala's docs, plus our CI. **Nothing has been run on Phala yet**, and the image has been built in CI but never run as a container (no Docker on the development machine). The first container run is on the CVM, which is why the plan starts with a short smoke deploy.

## Part A. Must be ready before any CVM time is spent (all free)

Do not start a CVM until every item here is done, or the hours are wasted.

| # | Item | Who | Why it blocks |
|---|---|---|---|
| 1 | **`SHIELD_API_KEY` approved and in `deploy/.env.phala`** | owner | The deployed service cannot use the dev bypass (and must not). Without the key every trade is blocked by the fail-closed Shield check: the demo could not trade. This is the biggest dependency. |
| 2 | **Autonomy decision, tested.** Either demo trades wait for norrfi.near to approve each swap in OutLayer's dashboard (visible in the video), or the OutLayer policy lets swaps skip approval while withdrawals stay gated. The second is untested; test it on the demo wallet (no CVM needed). | owner + me | Otherwise the agent's trades sit at `pending_approval` during the recording. |
| 3 | **Fund the demo vault for the script.** It holds about $8.93 USDC. The script as written ($40 NVDA, $50 limit, $5 SOL) needs roughly $60 to $100, or the script is rescaled to $5 to $6 trades (the NVDA floor is $5.10 for liquid stocks). | owner | A $40 buy fails for lack of funds. |
| 4 | **GHCR package `norr` set to public**, and the image built from the exact commit to deploy (CI does it on every push to main; the digest is in the run's summary). | owner | The CVM cannot pull a private image; the compose must pin the digest. |
| 5 | **Cloudflare Pages project created** (empty is fine) so its origin is known, for example `https://norr.pages.dev` or `https://app.norr.finance`. | owner | `NORR_ALLOWED_ORIGINS` is baked into the CVM's sealed environment and the sign-in is bound to it. |
| 6 | **Phala account ready:** `phala login` done, a payment method or credit in place, and the cheapest instance type chosen with `phala instance-types`. | owner | Deploy needs it. |
| 7 | **`deploy/.env.phala` filled in** from `deploy/env.phala.example`: `NORR_DATA_KEY` generated with `openssl rand -base64 32` and **a copy kept offline**, the OutLayer demo credentials, the 1Click key, the Shield key, `NORR_OWNER_ACCOUNT`, `NORR_ALLOWED_ORIGINS`, and `NORR_POLICY_JSON` (the policy from `config/policy.demo.local.json` as one line). Never pasted into chat, never committed (it is gitignored). | owner + me | These become sealed environment variables. |
| 8 | **`deploy/docker-compose.yml`** with both `REPLACE_WITH_DIGEST` values replaced by the digest from CI. | me | The attestation only means something if images are pinned by digest. |
| 9 | **Demo script and README updated** for the live window ("live demo available between these times; mock mode any time") and the amounts from item 3. | me | Judges who arrive when the CVM is stopped must still be able to run it. |

Already done: Dockerfile, CI, compose with the MCP service, CORS and origin-bound sign-in, the attestation endpoints and checks, the agent harness and model choice (`docs/AGENT-MODELS.md`).

## Part B. Session plan and cost (about 72 hours)

| Session | Hours | Purpose |
|---|---|---|
| Smoke deploy | about 2 | First container run. Fix whatever breaks, then stop. |
| Rehearsal | about 12 | Three clean runs of the demo, ideally 11 to 12 Nov. |
| Recording | about 6 | The demo video. |
| Judging window | about 52 | From submission until judging ends (confirm the dates on the hackathon page). |

Compute is billed only while the CVM runs. A stopped CVM costs no compute but **storage keeps billing** (listed at $0.000139 per GB-hour; 20 GB is about $0.07 a day) until the CVM is deleted. Delete it after judging.

Rough totals for 72 hours, using the two instance prices Phala's pages quote (check `phala instance-types` for the real list): about $0.069/h is $5.0, and about $0.232/h is $16.7. Add under $1 for storage. The service uses about 90 MB of memory, so the smallest type is enough. The $50 cap holds either way; confirm any welcome or gifted credit in the dashboard first.

## Part C. Deploy day, in order

1. **Authenticate and look.** `phala login` (you enter the API key; it is stored by the CLI), `phala status`, `phala instance-types`. Note the cheapest type and its price.
2. **Dry check of inputs.** Compose has digests, not tags. `deploy/.env.phala` has every key in the example. The Pages origin is final.
3. **Deploy:**
   ```
   phala deploy -n norr-demo -c deploy/docker-compose.yml -e deploy/.env.phala \
     -t <cheapest-type> --disk-size 20G --no-public-logs --no-public-sysinfo --wait
   ```
   `--no-public-logs` matters: **the CLI makes logs, system info and TCB info public by default**. Keep TCB info public (it lets anyone check the app configuration). Defaults not changed: KMS `phala`, filesystem `zfs`. Read the flags again with `phala deploy --help` if the CLI has updated.
4. **Find the addresses.** `phala cvms get --cvm-id norr-demo` and `phala ps --cvm-id norr-demo`. Two public URLs: the service (port 8787) and the MCP endpoint (port 8788). Check `phala logs --cvm-id norr-demo -n 100` for a clean start (only you can read them).
5. **Health.** `curl https://<service-url>/health` should say `{"ok":true,"mock":false}`. `curl https://<mcp-url>/health` should say `{"ok":true}`.
6. **Attestation, the real test of our checks:**
   ```
   pnpm exec tsx scripts/verify-attestation.mts https://<service-url>
   phala cvms attestation --cvm-id norr-demo
   ```
   Expect five PASS plus the Phala signature check. These checks have only been run against quotes built to the documented layout, so a failure here is most likely a layout detail; the failing check's message says which. Compare the compose hash with Phala's own view.
7. **Dashboard.** Build and deploy the Pages site with `VITE_NORR_API_URL=https://<service-url>`. Open it, sign in with HOT as norrfi.near, check Vaults, Verify (run "Check attestation"), Fund.
8. **Agent token.** Create one in the dashboard (Vaults, your agent). The token the service prints at startup is in the logs: revoke that one.
9. **Agent run:**
   ```
   NORR_AGENT_TOKEN=... pnpm --filter @norr/agent exec tsx src/cli.ts \
     --mcp https://<mcp-url>/mcp --model z-ai/glm-5.3-flash "Check my portfolio and rules, do not trade."
   ```
   Then the read-only task first, a small real trade only after you confirm it.
10. **Stop when done:** `phala cvms stop --cvm-id norr-demo`. Start it again with `phala cvms start`. To change environment values: `phala envs update`; to ship a new image: edit the digest and `phala deploy --cvm-id norr-demo ...`.
11. **After judging:** `phala cvms delete --cvm-id norr-demo` to stop storage billing.

## Part D. Known risks, and what we do about them

- **First container run.** Nothing has run the image. Mitigation: the 2-hour smoke deploy before anything depends on it.
- **Attestation checks never saw a real quote.** Mitigation: step 6 on the smoke deploy; the checks print what they compared.
- **Shield key late.** Without it the live demo cannot trade. Mitigation: ask now; if it does not arrive, the demo shows blocked trades (which are the interesting ones) and mock mode shows the rest, stated honestly in the README.
- **Judges arrive while the CVM is stopped.** Mitigation: README lists the live windows; mock mode (`NORR_MOCK=1`) runs the whole flow locally at any time.
- **`NORR_DATA_KEY` lost.** The saved ledger and counters become unreadable and the service refuses to start (by design). Mitigation: offline copy. After a loss, delete the CVM's volume to start clean; caps then start from zero, so do it only between sessions.
- **Phala's KMS is a trust assumption.** Keys are managed by Phala's KMS by default; the README names it next to OutLayer's.
- **Docs and CLI are marked UNSTABLE in places** and two Phala pages disagreed on instance specs and credits. Prefer `phala <command> --help` and `phala docs search` over this file when they differ.
