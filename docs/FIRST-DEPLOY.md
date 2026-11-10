# First deploy to Phala Cloud: checklist

Decision (2026-10-31): Norr runs **inside a TEE** for the demo and for judging. No outside-TEE hosting. The CVM runs only when needed (about 72 hours in total) and is stopped otherwise.

Everything here is read from the CLI's own help (`phala` 1.1.22) and Phala's docs, plus our CI. **Nothing has been run on Phala yet**, and the image has been built in CI but never run as a container (no Docker on the development machine). The first container run is on the CVM, which is why the plan starts with a short smoke deploy.

## Part A. Must be ready before any CVM time is spent (all free)

Do not start a CVM until every item here is done, or the hours are wasted.

| # | Item | Who | Why it blocks |
|---|---|---|---|
| 1 | **`SHIELD_API_KEY` approved and in `deploy/.env.phala`** | owner | The deployed service cannot use the dev bypass (and must not). Without the key every trade is blocked by the fail-closed Shield check: the demo could not trade. This is the biggest dependency. |
| 2 | ~~Autonomy decision~~ **Decided 2026-10-31: approvals kept.** Swaps and withdrawals share the one OutLayer type `confidential`, so they cannot be exempted separately (FINDINGS.md, "Autonomy"). Each live demo swap waits for norrfi.near to approve in OutLayer's dashboard, shown on camera. | done | Nothing blocks. |
| 3 | ~~Fund the demo vault~~ **Decided 2026-10-31: no extra funding; the script is rescaled** to $5.50 NVDA, $20 TSLA (blocked at the $10 limit), $5 GNEAR (blocked, a real low-liquidity token), $3 USDC to SOL. The vault's $8.93 cannot fund a $5 swap after a $5.50 buy, hence $3. | done | Nothing blocks. |
| 4 | ~~GHCR package public~~ done (package-level, so new digests stay public). **The image must still be built from the exact commit to deploy**: CI does it on every push to main; the digest is in the run's summary. | me | The CVM cannot pull a private image; the compose must pin the digest. |
| 5 | ~~Cloudflare Pages~~ **done 2026-11-02: live at `https://app.norr.finance`** (custom domain, previews off); set `NORR_ALLOWED_ORIGINS=https://app.norr.finance` exactly. Original note: Pages project created with the settings in `DEPLOY-DASHBOARD.md` ("Cloudflare Pages: exact settings") so its origin is known, for example `https://norr.pages.dev`. | owner | `NORR_ALLOWED_ORIGINS` is baked into the CVM's sealed environment and the sign-in is bound to it. |
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
3. **Deploy.** Use a **production OS image**. Without `--image`, Phala's CLI picked the **debug** image `dstack-dev-0.5.12` for the smoke test (SSH-capable, so not a meaningful attestation). `phala os-images` lists them; `DEV = no` is production.
   ```
   phala deploy -n norr-demo -c deploy/docker-compose.yml -e deploy/.env.phala \
     -t tdx.small --disk-size 20G --image dstack-0.5.12 \
     --public-logs --no-public-sysinfo --public-tcbinfo --wait
   ```
   `--public-logs` is **only for this first production deploy**, so a failure is visible (the production image has no shell). The CLI makes logs, system info and TCB info public by default; keep TCB info public (it lets anyone check the app configuration). Public logs include the agent token printed at startup. As soon as the service is healthy:
   ```
   phala deploy --cvm-id norr-demo -c deploy/docker-compose.yml -e deploy/.env.phala --no-public-logs --wait
   ```
   then **revoke the startup token** in the dashboard (Vaults) after creating your own. Defaults not changed: KMS `phala`, filesystem `zfs`. Re-read `phala deploy --help` if the CLI has updated. The Verify screen and `scripts/verify-attestation.mts` now fail an attestation from a known debug OS image (`os-image` check).
4. **Find the addresses.** `phala cvms get --cvm-id norr-demo` and `phala ps --cvm-id norr-demo`. Two public URLs: the service (port 8787) and the MCP endpoint (port 8788). Check `phala logs --cvm-id norr-demo -n 100` for a clean start (only you can read them).
5. **Health.** `curl https://<service-url>/health` should say `{"ok":true,"mock":false}`. `curl https://<mcp-url>/health` should say `{"ok":true}`.
6. **Attestation, the real test of our checks:**
   ```
   pnpm exec tsx scripts/verify-attestation.mts https://<service-url>
   phala cvms attestation --cvm-id norr-demo
   ```
   Expect five PASS plus the Phala signature check. The checks have been run against real dstack quotes (NEAR AI Cloud's, see FINDINGS.md) but not yet against one from our own CVM, so a failure here is most likely a detail specific to Phala's setup; the failing check's message says which. Compare the compose hash with Phala's own view.
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
- **Attestation checks never saw a quote from our own CVM.** They pass on real dstack quotes from NEAR AI Cloud (one bug was found and fixed that way). Mitigation: step 6 on the smoke deploy; the checks print what they compared. Phala's simulator does not run on this Intel Mac (aarch64 build only).
- **Shield key late.** Without it the live demo cannot trade. Mitigation: ask now; if it does not arrive, the demo shows blocked trades (which are the interesting ones) and mock mode shows the rest, stated honestly in the README.
- **Judges arrive while the CVM is stopped.** Mitigation: README lists the live windows; mock mode (`NORR_MOCK=1`) runs the whole flow locally at any time.
- **`NORR_DATA_KEY` lost.** The saved ledger and counters become unreadable and the service refuses to start (by design). Mitigation: offline copy. After a loss, delete the CVM's volume to start clean; caps then start from zero, so do it only between sessions.
- **Phala's KMS is a trust assumption.** Keys are managed by Phala's KMS by default; the README names it next to OutLayer's.
- **Docs and CLI are marked UNSTABLE in places** and two Phala pages disagreed on instance specs and credits. Prefer `phala <command> --help` and `phala docs search` over this file when they differ.
