import { defineConfig } from "vitest/config";

export default defineConfig({
  // The web app's component tests use JSX; each such file opts in to jsdom with a docblock.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}", "apps/landing/build/**/*.test.ts"],
    // Generous limits: some tests build a whole mock service or import every wallet package, which is slow on a busy or
    // small machine. A test that passes still finishes in milliseconds; this only stops a slow machine from failing it.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["./apps/web/vitest.setup.ts"],
  },
});
