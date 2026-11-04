/**
 * The dashboard's Content-Security-Policy, built at build time so the Norr service's origin (VITE_NORR_API_URL)
 * is allowed exactly, and nothing else is.
 *
 * Every third-party origin below was observed in a browser, not guessed (see docs/DEPLOY-DASHBOARD.md):
 * - HOT Wallet: its connect widget in an iframe (hot-labs.org), its relay (h4n.app) and its logo (storage.herewallet.app).
 * - NEAR RPC used by the wallet selector and Meteor: free.rpc.fastnear.com, mw.rpc.fastnear.com, rpc.mainnet.near.org.
 * - Verify's signature check: dcap-qvl runs as WebAssembly ('wasm-unsafe-eval' allows compiling WebAssembly only,
 *   not JavaScript eval) and fetches Intel-signed collateral from Phala's PCCS, the one cache that allows browsers.
 * - In-dashboard approvals: the browser reads each approval from OutLayer's public API and sends the owner's signed vote
 *   there directly (api.outlayer.ai allows any origin), so Norr can change neither what is shown nor what is signed.
 * Meteor and MyNearWallet open their own windows (not restricted by CSP) and talk back with postMessage.
 *
 * Deliberately blocked: the wallet modal's Google Fonts @import (the modal falls back to the page's own fonts),
 * inline scripts and styles, plugins, framing of this page, and form posts.
 */
export const THIRD_PARTY = {
  connect: ["https://h4n.app", "https://free.rpc.fastnear.com", "https://mw.rpc.fastnear.com", "https://rpc.mainnet.near.org", "https://pccs.phala.network", "https://api.outlayer.ai"],
  frame: ["https://hot-labs.org"],
  img: ["https://storage.herewallet.app"],
} as const;

/** The origin of VITE_NORR_API_URL, or null when the dashboard uses the same-origin /api proxy. */
export function apiOrigin(apiUrl: string | undefined): string | null {
  const v = apiUrl?.trim();
  return v ? new URL(v).origin : null;
}

export function buildCsp(apiUrl: string | undefined): string {
  const api = apiOrigin(apiUrl);
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", "'wasm-unsafe-eval'"]],
    ["style-src", ["'self'"]],
    ["img-src", ["'self'", "data:", ...THIRD_PARTY.img]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", ...(api ? [api] : []), ...THIRD_PARTY.connect]],
    ["frame-src", [...THIRD_PARTY.frame]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

/** The Cloudflare Pages `_headers` file for the dashboard. */
export function headersFile(apiUrl: string | undefined): string {
  return [
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    "  X-Frame-Options: DENY",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
    `  Content-Security-Policy: ${buildCsp(apiUrl)}`,
    "",
  ].join("\n");
}
