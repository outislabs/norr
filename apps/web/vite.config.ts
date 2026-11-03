import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { headersFile } from "./src/lib/csp";

// In development the app calls /api/..., which is proxied to the Norr service (default :8787, the mock service).
//
// The wallet-selector packages and their SDKs were written for bundlers that provide Node's `global`.
// Browsers (Safari throws "Can't find variable: global") do not, so it is mapped to globalThis, both in
// the production build and in the dev server's dependency pre-bundling. Buffer is polyfilled in main.tsx.
// Writes Cloudflare Pages' _headers at build time, so the CSP allows exactly the configured Norr service origin.
function securityHeaders(): Plugin {
  let apiUrl: string | undefined;
  return {
    name: "norr-security-headers",
    apply: "build",
    configResolved(c) {
      apiUrl = loadEnv(c.mode, c.envDir ?? process.cwd(), "VITE_").VITE_NORR_API_URL;
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: headersFile(apiUrl) });
    },
  };
}

// The wallet modal's stylesheet @imports Google Fonts. That request would tell Google who opens the modal, and the
// CSP blocks it, which makes Vite treat the whole stylesheet as failed. Drop remote @imports from dependency CSS;
// the modal is set to the page's own Geist in styles.css.
function stripRemoteCssImports(): Plugin {
  return {
    name: "norr-strip-remote-css-imports",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("node_modules") || !/\.css($|\?)/.test(id)) return null;
      const out = code.replace(/@import\s+url\(\s*["']?https?:\/\/[^)]*\)\s*;?/g, "");
      return out === code ? null : { code: out, map: null };
    },
  };
}

export default defineConfig({
  plugins: [stripRemoteCssImports(), react(), tailwindcss(), securityHeaders()],
  define: { global: "globalThis" },
  optimizeDeps: { rolldownOptions: { transform: { define: { global: "globalThis" } } } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.NORR_API_URL ?? "http://localhost:8787", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
});
