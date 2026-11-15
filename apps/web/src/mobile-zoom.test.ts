import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "styles.css"), "utf8");
const html = readFileSync(join(here, "../index.html"), "utf8");

// iPhone Safari zooms into a focused field whose text is under 16px; the fix must not take pinch-zoom away.
describe("no auto-zoom on iPhone, pinch-zoom kept", () => {
  it("touch screens get 16px in every text field, outside the Tailwind layers so nothing smaller wins", () => {
    const block = css.slice(css.indexOf("@media (pointer: coarse) {"), css.indexOf("@media (pointer: coarse) {") + 200);
    expect(block).toMatch(/input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)[^,]*, select, textarea \{ font-size: 16px; \}/);
    const before = css.slice(0, css.indexOf("@media (pointer: coarse)"));
    expect((before.match(/@layer [a-z]+ \{/g) ?? []).length).toBe(0); // not nested in a layer
  });

  it("html does not inflate text on rotation", () => {
    expect(css).toMatch(/html \{[^}]*-webkit-text-size-adjust: 100%;[^}]*text-size-adjust: 100%;/);
  });

  it("the viewport never disables zoom", () => {
    const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(viewport).toContain("width=device-width");
    expect(viewport).not.toMatch(/maximum-scale|user-scalable/);
  });
});
