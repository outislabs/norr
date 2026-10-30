import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the app calls /api/..., which is proxied to the Norr service (default :8787, the mock service).
//
// The wallet-selector packages and their SDKs were written for bundlers that provide Node's `global`.
// Browsers (Safari throws "Can't find variable: global") do not, so it is mapped to globalThis, both in
// the production build and in the dev server's dependency pre-bundling. Buffer is polyfilled in main.tsx.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { global: "globalThis" },
  optimizeDeps: { rolldownOptions: { transform: { define: { global: "globalThis" } } } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.NORR_API_URL ?? "http://localhost:8787", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
});
