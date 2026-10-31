# Deploying Norr on Phala Cloud, with attestation

Plan written 2026-10-30 from Phala's current docs (links at the end). Nothing here has been run yet: no account, CVM or image exists. Items the docs did not settle are listed under "Not settled".

## What runs where

One confidential VM (CVM) running one `docker-compose.yml`: the Norr service (`apps/enclave`, which also serves the MCP-over-HTTP endpoint if we mount it) plus, optionally, the static dashboard. Everything in one compose file runs in the same CVM.

The dashboard can instead be hosted as static files elsewhere; it holds no secrets and talks to the service over HTTPS. That is the simpler choice (see decisions).

## Deploy path

1. **Image.** Build the service image in CI (GitHub Actions) and push it to GHCR. The compose file must reference it by digest (`ghcr.io/outislabs/norr@sha256:...`), because Phala's verification guide requires every image to be pinned with `@sha256:` rather than a mutable tag. The git commit is baked in at build time as `NORR_COMMIT` so the Verify screen can show it. Optional: Sigstore build provenance (`actions/attest-build-provenance`) to link the digest to this repo.
2. **Compose.** Mount the dstack socket into the service container (`/var/run/dstack.sock` per the current attestation guide; older pages say `/var/run/tappd.sock`, so confirm with the CLI's generated example). Persist `NORR_DATA_DIR` on a CVM volume so the ledger and counters survive restarts and upgrades.
3. **Secrets.** Set as encrypted environment variables. The CLI/SDK encrypts them on the client (X25519 + AES-256-GCM) with a public key from the KMS, and only the CVM can decrypt them at boot. The set:
   - `NORR_DATA_KEY` (fresh, 32 random bytes; the only copy that can decrypt the persisted data, so back it up offline)
   - `OUTLAYER_DEMO_API_KEY`, `OUTLAYER_DEMO_ACCOUNT_ID`, `OUTLAYER_DEMO_WALLET_ID` (with `NORR_WALLET=demo`)
   - `ONECLICK_API_KEY`
   - `SHIELD_API_KEY` once approved. **`NORR_ENV` and `SHIELD_MODE=dev-bypass` must not be set.** Until the key exists the deployed service fails closed (every trade is blocked), which is the correct demo behaviour.
   - `NORR_OWNER_ACCOUNT=norrfi.near`
4. **Deploy.** `phala login`, then `phala deploy` with the compose file and `-e` env file (`phala deploy --cvm-id <id>` to update). `phala instance-types` lists sizes; `phala logs` for logs.
5. **Expose.** Phala fronts the CVM with an HTTPS hostname. Point the dashboard (`VITE_NORR_API_URL`) and the MCP client config at it. The service must allow the dashboard's origin.

## Attestation: what we build

- Add `@phala/dstack-sdk` and two **public, unauthenticated** endpoints:
  - `GET /attestation?nonce=...` returns the TDX quote (with the caller's nonce in `reportData`), the event log and `vm_config`.
  - `GET /info` returns the application configuration (`tcb_info.app_compose`).
- Verify screen: fetch both, then show the checks a stranger can repeat:
  1. `reportData` starts with our nonce (the quote is fresh).
  2. SHA-256 of `app_compose` equals the `compose-hash` event in the event log.
  3. The quote verifies (Phala's verification API, or `dcap-qvl` locally; `dstacktee/dstack-verifier` automates the platform check).
  4. Every image in `app_compose` is pinned by digest, and that digest matches the one published for this git commit.
- The README gets the exact commands to repeat this without trusting the dashboard.
- Optional later: register the compose hash on-chain (DstackApp `allowedComposeHashes`) for governed upgrades. Not needed for the hackathon.

## What this does and does not prove (for the README)

- It proves **which code and images** the CVM booted, on genuine TDX hardware.
- The docs did not say whether environment values are part of the measurement. Do not claim the attestation proves what the secrets are.
- Keys are managed by Phala's KMS by default: that is a trust assumption on Phala, to be named alongside OutLayer's (its gateway builds swap routes and its TEE does not re-check token or amount).
- Phala can still see traffic metadata, and the confidential layer is still visible to OutLayer and the private-chain operator (see PRIVACY.md).

## Not settled by the docs (check before relying on it)

- Instance specs and price: two Phala pages disagree on `tdx.medium` (one says 1 vCPU / 2 GB at $0.069/h, the docs say 4 vCPU / 8 GB). Check `phala instance-types` and the dashboard. A modest size is enough for this service.
- Whether CVM volumes persist across `phala deploy --cvm-id` upgrades (assumed yes; test with a throwaway value first).
- Whether `getQuote()` reportData is accepted at 64 bytes as a raw nonce (the docs say yes up to 64 bytes).
- CLI flags for region and disk, and the attestation CLI command: not documented on the reference page; use `--help`.

## Status (2026-10-31)

Built and tested: the `Dockerfile` (first CI build succeeded; digest in FINDINGS.md), `.dockerignore`, `deploy/docker-compose.yml`, the CI workflow, the inline policy (`NORR_POLICY_JSON`), CORS and origin-bound sign-in for a separately hosted dashboard (`docs/DEPLOY-DASHBOARD.md`), the public `/attestation` and `/info` endpoints, and the checks in `packages/shared/src/attestation.ts` used by the dashboard's Verify screen and `scripts/verify-attestation.mts`.

Not yet done, and what it needs:
- **Run against a real quote.** The checks have only seen quotes built to the documented layout (see FINDINGS.md). The first CVM is the first real test.
- **Attestation provenance** (linking the image digest to this repository's commit) needs the repository to be public.
- **First deployment** needs the owner's Phala login, a public GHCR package, and the secrets entered locally.

## Needed from the owner

1. A Phala Cloud account with a payment card or balance, and the monthly spend you accept.
2. An API key (profile, API Keys) in `.env` as `PHALA_CLOUD_API_KEY`, or run `phala login` yourself.
3. Decided: GHCR package public (set it public in the package settings after the first CI push; GitHub keeps new packages private by default), dashboard on Cloudflare Pages (`docs/DEPLOY-DASHBOARD.md`). Budget cap about $50 for the hackathon: use the smallest instance that runs the service.
4. The secrets above, entered into `.env` locally (never pasted into chat), plus the Shield key when it arrives.
5. A decision on the OutLayer policy for funding (see the Fund tab): the deposit-address request is gated as transaction type `call`.

## Work on our side

Dockerfile and compose, a CI workflow that builds and pins by digest, `/attestation` and `/info`, the Verify screen checks, a `NORR_POLICY_JSON`/mounted-file way to seed the policy, CORS for the dashboard origin, and a deploy script. Estimated half a day once the account and registry exist.

## Sources

- [Phala Cloud: create a CVM with Docker Compose](https://docs.phala.com/phala-cloud/phala-cloud-user-guides/create-cvm/create-with-docker-compose)
- [Generate a remote attestation report](https://docs.phala.com/phala-cloud/phala-cloud-user-guides/building-with-tee/generate-ra-report)
- [Verify your application](https://docs.phala.com/phala-cloud/attestation/verify-your-application)
- [Verify the platform](https://docs.phala.com/phala-cloud/attestation/verify-the-platform)
- [Set secure environment variables](https://docs.phala.com/phala-cloud/cvm/set-secure-environment-variables)
- [CLI reference](https://docs.phala.com/phala-cloud/references/tee-cloud-cli)
- [Pricing](https://docs.phala.com/phala-cloud/pricing)
