/**
 * Where the dashboard finds the Norr service. In development it is the same-origin "/api" proxy; for a hosted
 * dashboard (for example app.norr.finance on Cloudflare Pages) it is the service's https URL, set at build time
 * with VITE_NORR_API_URL. A remote service over plain http is refused: sessions travel as bearer tokens.
 */
export function resolveApiBase(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v) return "/api";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`VITE_NORR_API_URL "${v}" is not a URL`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("VITE_NORR_API_URL must be https (http is only allowed for localhost)");
  return v.replace(/\/+$/, "");
}
