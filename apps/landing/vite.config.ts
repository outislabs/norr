import { defineConfig } from "vite";

// A static page: no framework, no script. Fonts are bundled from @fontsource (no third-party font requests).
export default defineConfig({ server: { port: 5174 } });
