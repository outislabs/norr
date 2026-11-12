/**
 * The dashboard's Content-Security-Policy. It is built per request by the Cloudflare Pages Function
 * (functions/_middleware.ts), because NEAR Connect's wallet frames are inline scripts that only a per-request nonce can
 * allow, and the Norr service's origin (VITE_NORR_API_URL) is allowed exactly, and nothing else is.
 *
 * What is strict, and what NEAR Connect forced to be looser (found by reading the library, 2026-11-12):
 * - Scripts stay strict: `'self'` and the request's nonce, plus `'wasm-unsafe-eval'` for the dcap-qvl verifier. No
 *   `'unsafe-inline'`, no JavaScript eval, no third-party script origin. The nonce is what lets the wallet frames' inline
 *   scripts run; the library puts it on exactly those two scripts. The frames are sandboxed (`allow-scripts` only, so no
 *   access to this page, its storage or its cookies) and the wallet code in them is our own pinned copy, served from this
 *   origin (public/near-connect, SHA-256 in lock.json), never fetched from a third party.
 * - Styles are looser: `'unsafe-inline'`. The picker adds a `<style>` element to the page and the wallet frames add their
 *   own, none with a nonce, so no stricter style policy lets them render. Inline styles cannot run code.
 * - Wallet frames inherit this whole policy, so what the wallets themselves talk to is listed in THIRD_PARTY.wallets.
 *   Each entry says which wallet needs it. They were collected by loading every wallet in a browser (see
 *   docs/FINDINGS.md, "NEAR Connect"), not guessed.
 *
 * Deliberately blocked: inline and eval scripts, third-party scripts and styles, fonts from anywhere but here (wallet
 * frames fall back to system fonts), plugins, framing of this page, and form posts.
 */

/** Origins the page itself needs. */
const PAGE = {
  connect: [
    // Verify's signature check: dcap-qvl runs as WebAssembly and fetches Intel-signed collateral from Phala's PCCS, the one cache that allows browsers.
    "https://pccs.phala.network",
    // In-dashboard approvals: the browser reads each approval from OutLayer's public API and sends the owner's signed vote there directly.
    "https://api.outlayer.ai",
  ],
} as const;

/**
 * Origins the pinned wallets' own code talks to from inside their frames, by the wallet that needs each.
 *
 * Observed 2026-11-12: every wallet was loaded and chosen in Chrome against the real policy (Report-Only, so nothing was
 * blocked) and each violation recorded, desktop, connect phase only. Ledger, MyNearWallet, OKX, Nightly and Hana caused
 * none. Not observed: what a wallet asks for after the owner has approved in it, which a script cannot do. The sign-in
 * error names any origin the browser blocked, so a gap shows up as a message, not a silent failure.
 *
 * Left blocked on purpose: font stylesheets and files (fonts.cdnfonts.com, rsms.me, Google Fonts), which HOT, Meteor,
 * NEAR CLI and NEAR Mobile ask for and which would tell a font host who opens a wallet; the frames fall back to system fonts.
 */
export const WALLET_ORIGINS: Record<string, { connect: string[]; frame?: string[]; img?: string[] }> = {
  "hot-wallet": { connect: ["https://api0.herewallet.app", "https://h4n.app"], img: ["https://hot-labs.org"] },
  "meteor-wallet": { connect: ["https://mc.meteorwallet.app", "wss://mc.meteorwallet.app"], img: ["https://meteorwallet.app"] },
  "intear-wallet": { connect: [], frame: ["https://wallet.intear.tech"] },
  "near-mobile": { connect: ["https://near-mobile-production.aws.peersyst.tech"], img: ["https://near-mobile-production.aws.peersyst.tech"] },
  // Carried over from the previous policy (observed then, with the old selector's Meteor and MyNearWallet), not re-observed:
  // the NEAR RPC endpoints a wallet reads a transaction's outcome from after the owner signs it (the policy transaction).
  "near-rpc": { connect: ["https://rpc.mainnet.near.org", "https://free.rpc.fastnear.com", "https://mw.rpc.fastnear.com"] },
};

/** Native-app links NEAR Connect opens as hidden iframes (HOT, Meteor, Intear, Near Mobile): the schemes in their manifests' `allowsOpen`. */
export const APP_SCHEMES = ["hotwallet:", "intent:", "meteorwallet:", "intear:", "near-mobile-wallet:"] as const;

const uniq = (xs: string[]): string[] => [...new Set(xs)];

export const THIRD_PARTY = {
  get connect(): string[] {
    return uniq([...PAGE.connect, ...Object.values(WALLET_ORIGINS).flatMap((w) => w.connect)]);
  },
  get frame(): string[] {
    return uniq([...Object.values(WALLET_ORIGINS).flatMap((w) => w.frame ?? []), ...APP_SCHEMES]);
  },
  get img(): string[] {
    return uniq(Object.values(WALLET_ORIGINS).flatMap((w) => w.img ?? []));
  },
};

/** The origin of VITE_NORR_API_URL, or null when the dashboard uses the same-origin /api proxy. */
export function apiOrigin(apiUrl: string | undefined): string | null {
  const v = apiUrl?.trim();
  return v ? new URL(v).origin : null;
}

/** The policy for one response. `nonce` is that response's nonce (base64); without one, wallet frames cannot run. */
export function buildCsp(apiUrl: string | undefined, nonce?: string): string {
  const api = apiOrigin(apiUrl);
  if (nonce !== undefined && !/^[A-Za-z0-9+/]+={0,2}$/.test(nonce)) throw new Error("CSP nonce must be base64");
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", ...(nonce ? [`'nonce-${nonce}'`] : []), "'wasm-unsafe-eval'"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", ...THIRD_PARTY.img]],
    ["font-src", ["'self'", "data:"]], // data: is Meteor's embedded font; no host can be asked for one
    ["connect-src", ["'self'", ...(api ? [api] : []), ...THIRD_PARTY.connect]],
    ["frame-src", [...THIRD_PARTY.frame]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

/** The headers that do not depend on the request. */
export const STATIC_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

/** Every header for one response: the static ones and the CSP with this response's nonce. */
export function responseHeaders(apiUrl: string | undefined, nonce: string): Record<string, string> {
  return { ...STATIC_HEADERS, "Content-Security-Policy": buildCsp(apiUrl, nonce) };
}

/**
 * The Cloudflare Pages `_headers` file: the static headers only. The CSP is not here on purpose. It has to carry a
 * per-request nonce, so the Pages Function sets it, and a second, nonce-less CSP in this file would be enforced as well
 * and would block the wallet frames.
 */
export function headersFile(): string {
  return ["/*", ...Object.entries(STATIC_HEADERS).map(([k, v]) => `  ${k}: ${v}`), ""].join("\n");
}

/** A fresh base64 nonce (128 bits). */
export function newNonce(random: (n: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return btoa(String.fromCharCode(...random(new Uint8Array(16))));
}
