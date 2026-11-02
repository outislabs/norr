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

/**
 * The MCP endpoint agents connect to. Set VITE_NORR_MCP_URL, or it is derived: on Phala the service (port 8787) and the
 * MCP endpoint (8788) share a host name apart from the port label, and locally they are two ports on 127.0.0.1.
 */
export function resolveMcpUrl(raw: string | undefined, apiBase: string): string {
  const v = raw?.trim();
  if (v) {
    const u = new URL(v);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("VITE_NORR_MCP_URL must be https (http is only allowed for localhost)");
    return v.replace(/\/+$/, "");
  }
  if (/-8787\./.test(apiBase)) return `${apiBase.replace("-8787.", "-8788.")}/mcp`;
  return "http://127.0.0.1:8788/mcp";
}
