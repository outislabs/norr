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

1. **Preview deployments:** in Settings, Builds, set preview deployments to None (or accept that only the production address can sign in: the service allows exactly the origins in `NORR_ALLOWED_ORIGINS`, and every preview has its own address).
2. **Origin for the service:** put the production address, with no trailing slash, in `NORR_ALLOWED_ORIGINS` in `deploy/.env.phala` (for example `https://norr.pages.dev`). A custom domain later (`app.norr.finance`) means adding it to that list and redeploying the CVM's environment.
3. **Headers and routing:** `apps/web/public/_headers` is served as-is and routing is hash-based, so there are no redirect or rewrite rules to set.
4. **Without Git access:** build locally and upload instead: `VITE_NORR_API_URL=https://<service-host> pnpm --filter @norr/web build && pnpm dlx wrangler pages deploy apps/web/dist --project-name norr`.
5. Not set on purpose: a strict Content-Security-Policy. The wallet selector opens wallet pages and popups; add one only after testing it with HOT and Meteor.

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
