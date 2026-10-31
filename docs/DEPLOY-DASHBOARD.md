# Hosting the dashboard (Cloudflare Pages) against the Phala service

The dashboard is a static site (`apps/web`). It holds no secrets: it talks to the Norr service over HTTPS, signs in with the owner's NEAR wallet, and keeps its session in the tab.

## Build and deploy

1. In Cloudflare Pages, connect the repo (or `wrangler pages deploy apps/web/dist`).
2. Build command: `pnpm install --frozen-lockfile && pnpm --filter @norr/web build`. Output directory: `apps/web/dist`.
3. Build variable: `VITE_NORR_API_URL=https://<your-service>.<phala-host>`. It must be `https`; the build refuses plain `http` for anything but localhost. Routing is hash-based, so no rewrite rules are needed.
4. Custom domain: `app.norr.finance`.
5. `apps/web/public/_headers` is served as-is (no sniffing, no framing, no referrer, no camera/mic/location). A strict Content-Security-Policy is deliberately not set: the wallet selector opens wallet pages and popups, and a wrong policy would break sign-in. Add one only after testing it with HOT and Meteor.

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
