# Verify the enclave

The Norr service runs in an Intel TDX confidential VM on Phala. It answers two public endpoints, `/attestation?nonce=…` and `/info`, so anyone can check which code is running without trusting Norr's word. No account is needed.

## In the browser

Open [app.norr.finance/#/verify](https://app.norr.finance/#/verify) and choose **Check attestation**. Your browser picks a random nonce, asks the service for a fresh hardware quote, and runs seven checks on it locally:

1. **The quote is a TDX quote** (version 4).
2. **It answers your nonce**: the quote was made for this request, not replayed.
3. **The configuration matches**: SHA-256 of the app configuration equals the measured compose-hash event.
4. **The event log replays**: replaying the boot events reproduces the quote's RTMR3 register.
5. **Production OS**: the VM runs a production dstack image, not a debug one.
6. **Exact images**: every container image is pinned by digest.
7. **Genuine Intel hardware**: the quote's signature chain verifies up to Intel's root certificate. This runs in your browser with Phala's `dcap-qvl` verifier compiled to WebAssembly. It fetches Intel-signed certificate data from Phala's certificate cache (which can withhold it but cannot forge it) and sends the quote nowhere.

If the browser check cannot run, the page offers the quote to copy into [Phala's TEE Attestation Explorer](https://proof.t16z.com/).

## From a terminal

```
git clone https://github.com/outislabs/norr && cd norr && pnpm install
pnpm exec tsx scripts/verify-attestation.mts https://85e1d6a557dae81985c9e30e28270f91bee5c0e9-8787.dstack-pha-prod5.phala.network
```

Same checks; the seventh asks Phala's verification API. The service runs on demand during the pilot, so it may be offline; the dashboard says so.

## Check the domain

`mcp.norr.finance` is served by Phala's dstack-ingress inside the CVM: its TLS certificate is issued and held there, and published at `https://mcp.norr.finance/evidences/` with a TDX quote over it. This checks that the certificate your client sees belongs to the attested app:

```
pnpm exec tsx scripts/verify-domain.mts mcp.norr.finance https://85e1d6a557dae81985c9e30e28270f91bee5c0e9-8787.dstack-pha-prod5.phala.network
```

It verifies the evidence quote's signature chain, that the quote covers the published certificate, that the certificate served over TLS is that one, and that the quote comes from the same VM and configuration as a fresh attestation of the service. It also reports whether CAA pins certificate issuance for the name to the CVM's own ACME account.

## Match the code

The checks report the git commit, the compose hash and the image digests. Compare them with the repository:

- The images in `deploy/docker-compose.yml` are pinned by digest.
- Images are built in CI with signed build provenance. Check one:
  ```
  gh attestation verify oci://ghcr.io/outislabs/norr@sha256:<digest> --repo outislabs/norr
  ```
- The values observed for the current deployment are listed in the README, "Verify it yourself".

## What this proves, and what it does not

It proves which code and images booted, on genuine Intel TDX hardware, just now. It does not prove what secrets the VM was given (Phala's key service is a trust assumption), and it says nothing about the custody provider, whose limits you set separately.
