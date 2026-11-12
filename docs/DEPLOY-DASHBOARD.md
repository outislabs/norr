# Hosting the dashboard (Cloudflare Pages) against the Phala service

The dashboard is a static site (`apps/web`). It holds no secrets: it talks to the Norr service over HTTPS, signs in with the owner's NEAR wallet, and keeps its session in the tab.

## Cloudflare Pages: exact settings

Create the project now, before the CVM exists: with `VITE_NORR_API_URL` unset the build falls back to the same-origin `/api` and still succeeds, and the project's address (which the service must allow) is known the moment it is created.

Workers & Pages, Create application, **Pages**, Connect to Git, pick `outislabs/norr` (the Cloudflare GitHub app needs access to that private repository), then:

| Setting | Value |
|---|---|
| Project name | `norr` (the address becomes `https://norr.pages.dev`; if the name is taken Cloudflare appends letters, so copy the real address) |
| Production branch | `main` |
| Framework preset | None |
| Root directory | leave empty (the repository root: the build needs the workspace lockfile) |
| Build command | `pnpm install --frozen-lockfile && pnpm --filter @norr/web build` |
| Build output directory | `apps/web/dist` |
| Node version | from `.node-version` in the repo (`22`); set no `NODE_VERSION` variable |
| Environment variable `PNPM_VERSION` | `10.18.0` (Cloudflare's v3 image reads pnpm's version only from this variable; its docs do not mention the `packageManager` field or corepack) |
| Environment variable `VITE_NORR_API_URL` | leave unset until the CVM exists; then `https://<service-host>` (https only, no trailing path). It is read at build time, so changing it needs a new deployment (Deployments, Retry, or push a commit) |

If the first build stops at "Failed: an internal error occurred" right after "No Wrangler configuration file found" (seen 2026-11-02, before any install), the cause is not documented by Cloudflare. In order: retry the deployment once (it may be on their side); remove `PNPM_VERSION` (the image's pnpm 10.11.1 then installs, and the lockfile format is the same); then, as a last resort, build locally and use the direct upload in step 4 below.

Then:

1. **Preview deployments:** each preview has its own address, and the service allows exactly the origins in `NORR_ALLOWED_ORIGINS`, so a preview can sign in only after its address is added there (and the CVM's environment updated). Without that, set preview deployments to None.
2. **Origin for the service:** put the production address, with no trailing slash, in `NORR_ALLOWED_ORIGINS` in `deploy/.env.phala` (for example `https://norr.pages.dev`). A custom domain later (`app.norr.finance`) means adding it to that list and redeploying the CVM's environment.
3. **Headers and routing (changed 2026-11-12, NEAR Connect):** the Content-Security-Policy now carries a per-request nonce, so it is set by a Pages Function (`functions/_middleware.ts`), not by `_headers`. The build writes `dist/_headers` (the headers that do not change per request) and `dist/csp-config.json` (the service origin from `VITE_NORR_API_URL`); the Function reads that file, builds the policy with `apps/web/src/lib/csp.ts`, sets it with a fresh nonce on every response and puts the same nonce in the page for the wallet connector. Pages deploys the repository's `functions/` folder on its own when the project is connected to Git. `_headers` deliberately has no CSP: a second, nonce-less policy would be enforced as well and would block the wallet frames. Routing is hash-based, so there are no redirect or rewrite rules.
4. **Without Git access:** build locally and upload instead: `VITE_NORR_API_URL=https://<service-host> pnpm --filter @norr/web build && pnpm dlx wrangler pages deploy apps/web/dist --project-name norr`. Run it from the repository root so Wrangler finds `functions/`; without it the page is served with no CSP at all (check with `curl -sI <address> | grep -i content-security`).
5. **Content-Security-Policy** (`apps/web/src/lib/csp.ts`; first 2026-11-03, rebuilt for NEAR Connect 2026-11-12). Scripts stay strict: the dashboard itself, this response's nonce and `'wasm-unsafe-eval'` (WebAssembly only, for the `dcap-qvl` verifier); no `'unsafe-inline'`, no JavaScript `eval`, no third-party script origin. Also no framing of the dashboard, no plugins, no form posts, no font host. Two things are looser than before, and why:
   - **Inline styles** (`style-src 'unsafe-inline'`): NEAR Connect's picker adds a `<style>` element to the page and each wallet's frame adds its own, none with a nonce, so no stricter style policy lets them render. Inline styles cannot run code.
   - **Wallet code runs in sandboxed frames inside the page.** NEAR Connect loads each wallet's "executor" script and runs it in an iframe with `sandbox="allow-scripts"` (no access to this page, its storage or cookies). The frames' inline scripts run only because they carry the nonce. The executors are **not** fetched from third parties: `apps/web/public/near-connect` holds pinned copies (SHA-256 in `lock.json`, checked by a test and by `pnpm exec tsx scripts/vendor-near-connect-wallets.mts --check`). Updating a wallet is a reviewed commit: run the script without `--check`, read the diff.

   The frames inherit this policy, so what the wallets themselves talk to is listed (`WALLET_ORIGINS` in `csp.ts`, with the wallet that needs each). They were observed by loading every wallet in a browser against the real policy in Report-Only mode on 2026-11-12, not guessed:

   | Origin | Directive | Why |
   |---|---|---|
   | `https://h4n.app`, `https://api0.herewallet.app` | connect-src | HOT Wallet's relay and API |
   | `https://hot-labs.org` | img-src | HOT Wallet's icon in its connect screen |
   | `https://mc.meteorwallet.app`, `wss://mc.meteorwallet.app` | connect-src | Meteor Wallet's backend |
   | `https://meteorwallet.app` | img-src | Meteor Wallet's images |
   | `https://wallet.intear.tech` | frame-src | Intear Wallet's own page, in a frame |
   | `https://near-mobile-production.aws.peersyst.tech` | connect-src, img-src | NEAR Mobile's backend and images |
   | `hotwallet:`, `intent:`, `meteorwallet:`, `intear:`, `near-mobile-wallet:` | frame-src | Native-app links, which NEAR Connect opens as hidden frames |
   | `https://api.outlayer.ai` | connect-src | In-dashboard approvals: the browser reads each approval from OutLayer's public API and sends the owner's signed vote there directly |
   | `https://pccs.phala.network` | connect-src | Intel-signed certificate data (TCB info, QE identity, CRLs) for Verify |
   | `https://free.rpc.fastnear.com`, `https://mw.rpc.fastnear.com`, `https://rpc.mainnet.near.org` | connect-src | NEAR RPC, where a wallet reads a transaction's outcome (carried over from the old policy, not re-observed) |
   | `data:` | font-src | Meteor's embedded font |

   Ledger, MyNearWallet, OKX, Nightly and Hana caused no violation. **Not observed**: what a wallet asks for after the owner approves inside it, which a script cannot do; the sign-in error names any origin the browser blocked, so a gap shows up as a message. **Blocked on purpose**: font stylesheets and files (`fonts.cdnfonts.com`, `rsms.me`, Google Fonts), which would tell a font host who opens a wallet; wallet screens fall back to system fonts. NEAR Mobile's three "download the app" links use inline `onclick` handlers, which the CSP blocks, so they do nothing; the wallet itself still works. Windows that wallets open themselves (MyNearWallet, Meteor, Intear) are not restricted by this policy.
6. **What NEAR Connect adds to trust, and what the dashboard does about it.** The library registers a wallet when any window posts it a message and lets the picker paste in a custom wallet manifest; the dashboard turns off custom wallets and auto-connect, ignores remembered custom wallets, and strips any wallet that talks to the parent window (`apps/web/src/lib/nearconnect.ts`, each claim tested against the real library in `nearconnect.test.ts`).

## The service side

Set on the Phala CVM (not secret, so they can be plain environment variables):

```
NORR_ALLOWED_ORIGINS=https://app.norr.finance
```

What that turns on:

- **CORS for the owner API only** (`/owner/v1/*`), for exactly those origins. The agent API (`/v1/*`) never answers browsers. `/health` answers any origin (it reveals only that the service is up).
- **Sign-in bound to the dashboard.** The challenge is issued only to an allowed `Origin`, the signed message names the site ("Sign in to Norr at https://app.norr.finance"), and the login must come from the same origin. A challenge issued to the dashboard cannot be completed from another site.
- No cookies and no `Access-Control-Allow-Credentials`: sessions are bearer tokens held in the tab, so a third-party page cannot ride an existing browser session.

## What this does not protect

- A phishing site can still ask the service for a challenge by lying about its `Origin` from a server (the header is only trustworthy coming from a browser) and then show the message to a victim. The wallet is what stops that: it shows the requesting site, and the message itself names the dashboard. Check both before you sign.
- The session token and the unlock key for private reasoning live in `sessionStorage`, readable by any script that runs on the dashboard origin. The dashboard has no third-party scripts, and the build pins its dependencies in the lockfile.
- Anyone who learns an agent token can trade within the vault's rules until it is revoked; that is unchanged by hosting.

## Checklist after the first deploy

1. Open `https://app.norr.finance`, sign in with HOT as the owner, confirm the Vaults page loads.
2. In the browser's network tab, the calls go to the service host and succeed (no CORS errors).
3. Try the sign-in from a different origin (for example `localhost`): the service should answer 403/401.
4. Verify screen: the commit shown matches the one in the CI summary.
5. With the browser console open, sign in with each wallet you use and run Check attestation: there should be no Content-Security-Policy violations other than font hosts (`fonts.cdnfonts.com`, `rsms.me`) and, for Meteor, its `eval` probe. Any other blocked origin is shown in the sign-in error: add it to `WALLET_ORIGINS` with the wallet that needs it.
6. `curl -sI <address> | grep -i content-security-policy` shows a policy with a `nonce-` in `script-src`, and the page source has `<meta name="norr-csp-nonce">`.
