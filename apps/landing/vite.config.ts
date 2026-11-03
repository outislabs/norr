import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { PAGES, llmsFullTxt, llmsTxt, readSource, writePages } from "./build/docs";

// A static site: no framework, no client script. Fonts are bundled from @fontsource (no third-party font requests).
// The docs (content/docs/*.md) are rendered to static pages at build time, alongside llms.txt and llms-full.txt.
const root = resolve(import.meta.dirname);
const content = join(root, "content/docs");

function docs(): Plugin {
  return {
    name: "norr-docs-text",
    // The raw Markdown of each page, and the agent-facing text files, are emitted next to the HTML.
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "llms.txt", source: llmsTxt() });
      this.emitFile({ type: "asset", fileName: "llms-full.txt", source: llmsFullTxt(content) });
      for (const p of PAGES) this.emitFile({ type: "asset", fileName: `docs/${p.slug ? `${p.slug}/` : ""}index.md`, source: readSource(content, p) });
    },
  };
}

export default defineConfig({
  server: { port: 5174 },
  plugins: [docs()],
  build: { rollupOptions: { input: { main: join(root, "index.html"), ...writePages(root) } } },
});
