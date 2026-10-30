import { defineConfig } from "vitest/config";

export default defineConfig({
  // The web app's component tests use JSX; each such file opts in to jsdom with a docblock.
  esbuild: { jsx: "automatic" },
  test: { include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}"] },
});
