import { describe, expect, it } from "vitest";
import config from "../vite.config";

describe("vite config", () => {
  // Safari has no Node-style `global`: "Can't find variable: global" broke the wallet sign-in before the picker opened.
  it("maps global to globalThis in the build and in the dev server's dependency pre-bundling", () => {
    expect(config.define).toMatchObject({ global: "globalThis" });
    expect(config.optimizeDeps?.rolldownOptions?.transform?.define).toMatchObject({ global: "globalThis" });
  });
});
