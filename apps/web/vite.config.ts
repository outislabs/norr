import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the app calls /api/..., which is proxied to the Norr service (default :8787, the mock service).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.NORR_API_URL ?? "http://localhost:8787", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
});
