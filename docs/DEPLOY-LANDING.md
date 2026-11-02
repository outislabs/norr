# Hosting the landing page (norr.finance)

`apps/landing` is a static page with no script and no framework. Fonts are bundled, so a visitor's browser makes no third-party request. It links to the dashboard (`https://app.norr.finance`), the repository and `@norrfi` on X.

## Cloudflare Pages: a second, separate project

Workers & Pages, Create application, **Pages**, Connect to Git, `outislabs/norr`, then:

| Setting | Value |
|---|---|
| Project name | `norr-landing` |
| Production branch | `main` |
| Framework preset | None |
| Root directory | empty (the repository root: the build needs the workspace lockfile) |
| Build command | `pnpm install --frozen-lockfile && pnpm --filter @norr/landing build` |
| Build output directory | `apps/landing/dist` |
| Environment variable `PNPM_VERSION` | `10.18.0` |
| Node version | from `.node-version` (`22`); set no `NODE_VERSION` |

Settings, Builds: set preview deployments to None, as for the dashboard.

## Custom domain and DNS

The `norr.finance` zone is already on Cloudflare (the dashboard runs on `app.norr.finance`), so no registrar changes are needed:

1. Pages project `norr-landing`, Custom domains, **Set up a custom domain**, enter `norr.finance`. Cloudflare adds the apex CNAME (flattened) to `norr-landing.pages.dev` and issues the certificate. Wait until it shows Active.
2. Add `www.norr.finance` the same way, then redirect it to the apex: Rules, Redirect Rules, "www to apex", when hostname equals `www.norr.finance`, redirect (301) to `https://norr.finance` with the path preserved.
3. Leave the `app` record alone: it belongs to the dashboard project.

If the apex already has a record (a parked page or an A record), delete it first, or Pages cannot attach the domain.

## Checks after deploy

- `curl -sI https://norr.finance | head -5` returns 200, and the response carries the headers from `apps/landing/public/_headers` (no inline script is allowed: `script-src 'none'`).
- The page works at 390 px wide with no horizontal scroll.
- "Open dashboard" goes to `https://app.norr.finance`; "Check the enclave yourself" goes to `https://app.norr.finance/#/verify`, which must work without signing in.
- The GitHub links 404 for visitors while the repository is private. Make it public before sharing the link.
