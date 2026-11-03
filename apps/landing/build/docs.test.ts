import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAGES, llmsFullTxt, llmsTxt, pageHtml, readSource, renderMarkdown } from "./docs";

const content = join(dirname(fileURLToPath(import.meta.url)), "../content/docs");

describe("norr.finance/docs", () => {
  it("has a Markdown source for every page, each starting with one title", () => {
    for (const p of PAGES) {
      const md = readSource(content, p);
      expect(md.match(/^# /gm)).toHaveLength(1);
    }
  });

  it("links only to pages that exist", () => {
    const known = new Set(PAGES.map((p) => (p.slug ? `/docs/${p.slug}/` : "/docs/")));
    for (const p of PAGES) {
      for (const [, href] of readSource(content, p).matchAll(/\]\((\/docs\/[^)#]*)/g)) expect(known, `${p.slug}: ${href}`).toContain(href);
    }
  });

  it("renders linkable headings and scrollable tables, with no script", () => {
    const html = renderMarkdown("# T\n\n## Block codes\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(html).toContain('<h2 id="block-codes"><a class="anchor" href="#block-codes">Block codes</a></h2>');
    expect(html).toContain('<div class="table-wrap"><table>');
    for (const p of PAGES) expect(pageHtml(p, readSource(content, p))).not.toMatch(/<script|\son[a-z]+="/i);
  });

  it("marks the current page in the side navigation and links the raw Markdown", () => {
    const html = pageHtml(PAGES[1]!, readSource(content, PAGES[1]!));
    expect(html).toContain('<a href="/docs/quickstart/" aria-current="page">Quickstart</a>');
    expect(html).toContain('href="/docs/quickstart/index.md"');
  });

  it("llms.txt lists every page; llms-full.txt contains every page's text", () => {
    const short = llmsTxt();
    const full = llmsFullTxt(content);
    expect(short.startsWith("# Norr\n\n> ")).toBe(true);
    for (const p of PAGES.filter((x) => x.slug)) expect(short).toContain(`https://norr.finance/docs/${p.slug}/index.md`);
    for (const p of PAGES) expect(full).toContain(readSource(content, p).trim().split("\n")[0]!);
  });

  it("names only repository files that exist", () => {
    const root = join(content, "../../../..");
    for (const p of PAGES) {
      for (const [, path] of readSource(content, p).matchAll(/`((?:apps|packages|scripts|deploy|docs)\/[A-Za-z0-9_./-]+)`/g)) {
        expect(existsSync(join(root, path!.replace(/\/$/, ""))), path).toBe(true);
      }
    }
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("pnpm judge");
  });
});
