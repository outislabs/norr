import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { apiOrigin, headersFile } from "./src/lib/csp";

// In development the app calls /api/..., which is proxied to the Norr service (default :8787, the mock service).
//
// Writes, at build time, the two files the Cloudflare Pages deployment needs for security headers:
// - _headers: the headers that do not change per request (nosniff, no-referrer, no framing, permissions).
// - csp-config.json: the Norr service origin (VITE_NORR_API_URL). The Pages Function (functions/_middleware.ts) reads it
//   to build the Content-Security-Policy, with a fresh nonce for every response, so the CSP allows exactly that origin.
function securityHeaders(): Plugin {
  let apiUrl: string | undefined;
  return {
    name: "norr-security-headers",
    apply: "build",
    configResolved(c) {
      apiUrl = loadEnv(c.mode, c.envDir ?? process.cwd(), "VITE_").VITE_NORR_API_URL;
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: headersFile() });
      this.emitFile({ type: "asset", fileName: "csp-config.json", source: JSON.stringify({ apiUrl: apiOrigin(apiUrl) ?? undefined }) + "\n" });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), securityHeaders()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.NORR_API_URL ?? "http://localhost:8787", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
});
