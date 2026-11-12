/**
 * Cloudflare Pages Function: sets the dashboard's Content-Security-Policy with a fresh nonce on every response and puts
 * the same nonce in the page (<meta name="norr-csp-nonce">), where the wallet connector reads it.
 *
 * Why a Function: NEAR Connect's wallet frames are inline scripts. A static `_headers` CSP can only allow them with
 * `'unsafe-inline'`; a per-request nonce allows exactly the two scripts the connector marks and nothing an attacker could
 * inject. The policy itself is built in apps/web/src/lib/csp.ts (tested there), so this file only wires it to requests.
 *
 * Fail-closed where it can be: if the build's CSP config cannot be read, the policy allows no external API origin
 * (the dashboard then cannot reach the service, which is visible and safe). If this Function is not deployed at all there
 * is no CSP: `pnpm check:deploy` (scripts/check-dashboard-headers.mts) checks a deployed address for it.
 */
import { newNonce, responseHeaders } from "../apps/web/src/lib/csp";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}
interface Context {
  request: Request;
  env: Env;
  next(): Promise<Response>;
}
/** Cloudflare's streaming HTML rewriter (a Workers global; not in the DOM typings). */
declare class HTMLRewriter {
  on(selector: string, handlers: { element(el: { append(html: string, options: { html: boolean }): void }): void }): HTMLRewriter;
  transform(response: Response): Response;
}

let apiUrl: Promise<string | undefined> | undefined;
/** The service origin the build was made for (csp-config.json, written by the build). Read once per isolate. */
const configuredApiUrl = (ctx: Context): Promise<string | undefined> =>
  (apiUrl ??= ctx.env.ASSETS.fetch(new Request(new URL("/csp-config.json", ctx.request.url)))
    .then(async (r) => (r.ok ? ((await r.json()) as { apiUrl?: string }).apiUrl : undefined))
    .catch(() => undefined));

export const onRequest = async (ctx: Context): Promise<Response> => {
  const nonce = newNonce();
  const [res, api] = await Promise.all([ctx.next(), configuredApiUrl(ctx)]);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(responseHeaders(api, nonce))) headers.set(k, v);
  const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
  if (!isHtml) return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  // The page carries this response's nonce, so it must not be served again to anyone else.
  headers.set("Cache-Control", "no-store");
  const page = new HTMLRewriter().on("head", { element: (el) => el.append(`<meta name="norr-csp-nonce" content="${nonce}">`, { html: true }) }).transform(res);
  return new Response(page.body, { status: res.status, statusText: res.statusText, headers });
};
