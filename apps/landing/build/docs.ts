/**
 * Builds norr.finance/docs from Markdown (content/docs/*.md) into static pages in the landing page's design, plus
 * llms.txt and llms-full.txt for agents. One source of truth: the same Markdown is the page, the raw `.md` served next
 * to it, and the text in llms-full.txt. No client script: pages are plain HTML (the site's CSP is script-src 'none').
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";

export const SITE = "https://norr.finance";

export interface DocPage {
  slug: string; // "" for the index
  nav: string;
  description: string;
}

/** Order, sidebar label and summary of every page. */
export const PAGES: DocPage[] = [
  { slug: "", nav: "Overview", description: "What Norr is and where to start." },
  { slug: "quickstart", nav: "Quickstart", description: "Sign in, fund the vault from any chain, connect an agent, watch, approve and stop it." },
  { slug: "connect-agent", nav: "Connect your agent", description: "MCP setup for Claude Code, Claude Desktop and any MCP client, with the agent token." },
  { slug: "mcp-tools", nav: "MCP tools", description: "The nine tools, what trade answers, and every block code." },
  { slug: "api", nav: "API reference", description: "The agent REST API behind the MCP tools, generated from the OpenAPI spec (openapi.json)." },
  { slug: "rules", nav: "Rules and limits", description: "The rules you set, the presets, Scam Shield, stock eligibility and the custody provider's limits." },
  { slug: "privacy", nav: "Privacy model", description: "Who sees what: the public, the custody provider, NEAR Intents, the Norr service and you." },
  { slug: "verify", nav: "Verify the enclave", description: "Check the running code yourself: seven attestation checks in the browser or a terminal." },
  { slug: "faq", nav: "FAQ", description: "Keys, safety, chains, wallets, costs and eligibility." },
  { slug: "limitations", nav: "Limitations and roadmap", description: "What Norr does not do yet, stated plainly, and what comes next." },
];

const href = (slug: string) => (slug ? `/docs/${slug}/` : "/docs/");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slugify = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The OpenAPI spec of the agent API, the single source for the API reference page and /openapi.json. */
export const OPENAPI_PATH = join(import.meta.dirname, "../../enclave/openapi.json");

export function readSource(contentDir: string, p: DocPage): string {
  if (p.slug === "api") return apiReferenceMd(JSON.parse(readFileSync(OPENAPI_PATH, "utf8")));
  return readFileSync(join(contentDir, `${p.slug || "index"}.md`), "utf8");
}

// ---------- API reference, generated from openapi.json ----------

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function typeOf(spec: Obj, s: Obj | undefined): string {
  if (!s) return "";
  if (s.$ref) return s.$ref.split("/").pop();
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v: unknown) => `\`${v}\``).join(", ");
  if (s.oneOf) return s.oneOf.map((x: Obj) => typeOf(spec, x)).join(" or ");
  if (s.type === "array") return `${typeOf(spec, s.items)}[]`;
  return ([] as string[]).concat(s.type ?? "").join(" or ");
}

function fieldsTable(spec: Obj, schema: Obj): string {
  const s = schema.$ref ? schema.$ref.split("/").slice(1).reduce((o: Obj, k: string) => o[k], spec) : schema;
  if (s.oneOf) return s.oneOf.map((x: Obj) => `One of: ${typeOf(spec, x)}`).join("\n\n");
  const props = Object.entries((s.properties ?? {}) as Obj);
  if (!props.length) return `\`${typeOf(spec, s)}\``;
  const req = new Set(s.required ?? []);
  return ["| Field | Type | |", "|---|---|---|", ...props.map(([k, v]) => `| \`${k}\` | ${cell(typeOf(spec, v))} | ${req.has(k) ? "required" : ""}${v.description ? `${req.has(k) ? ". " : ""}${cell(v.description)}` : ""} |`)].join("\n");
}

export function apiReferenceMd(spec: Obj): string {
  const out: string[] = [
    "# API reference",
    "",
    `${spec.info.description}`,
    "",
    `The machine-readable spec is [openapi.json](/openapi.json) (OpenAPI ${spec.openapi}); this page is generated from it.`,
    "",
    "## Servers",
    "",
    ...spec.servers.map((s: Obj) => `- \`${s.url}\`: ${s.description}`),
    "",
    "## Authentication",
    "",
    "Send the vault's agent token on every `/v1` request: `Authorization: Bearer <agent token>`. Create one in the dashboard (Connect). A token works for one vault only.",
    "",
  ];
  for (const tag of spec.tags as Obj[]) {
    out.push(`## ${tag.name}`, "", tag.description, "");
    for (const [path, ops] of Object.entries(spec.paths as Obj)) {
      for (const [method, op] of Object.entries(ops as Obj)) {
        if (!(op.tags ?? []).includes(tag.name)) continue;
        out.push(`### ${method.toUpperCase()} ${path}`, "", `**${op.summary}.** ${op.description ?? ""}`.trim(), "");
        if (op.security && op.security.length === 0) out.push("No token needed.", "");
        const params = (op.parameters ?? []).map((p: Obj) => (p.$ref ? p.$ref.split("/").slice(1).reduce((o: Obj, k: string) => o[k], spec) : p));
        if (params.length) out.push("| Query parameter | Type | |", "|---|---|---|", ...params.map((p: Obj) => `| \`${p.name}\` | ${cell(typeOf(spec, p.schema))} | ${p.required ? "required. " : ""}${cell(p.description ?? "")} |`), "");
        const body = op.requestBody?.content?.["application/json"]?.schema;
        if (body) out.push(`Request body (\`${typeOf(spec, body)}\`):`, "", fieldsTable(spec, body), "");
        const ok = op.responses?.["200"]?.content?.["application/json"]?.schema;
        if (ok) out.push(`Response \`200\` (\`${typeOf(spec, ok)}\`):`, "", fieldsTable(spec, ok), "");
        const errors = Object.keys(op.responses ?? {}).filter((c) => c !== "200");
        if (errors.length) out.push(`Other responses: ${errors.map((c) => `\`${c}\``).join(", ")}.`, "");
      }
    }
  }
  out.push("## Decisions", "", "What `POST /v1/trade` answers (`Decision`), by `status`:", "");
  for (const name of ["Executed", "Blocked", "PendingApproval", "Failed"]) out.push(`**${name}**`, "", fieldsTable(spec, spec.components.schemas[name]), "");
  out.push("Block codes and what they mean: [MCP tools](/docs/mcp-tools/#block-codes).", "");
  return out.join("\n");
}

const titleOf = (md: string): string => md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Norr docs";

/** Markdown to HTML: headings get ids (h2 and h3 linkable), tables scroll inside their own box on narrow screens. */
export function renderMarkdown(md: string): string {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        if (depth === 1) return `<h1>${text}</h1>\n`;
        const id = slugify(text);
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${text}</a></h${depth}>\n`;
      },
    },
  });
  const html = marked.parse(md, { async: false }) as string;
  return html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
}

function header(active: "docs" | "home"): string {
  const docs = `<a href="/docs/" class="${active === "docs" ? "nav-text nav-active" : "muted nav-text"}"${active === "docs" ? ' aria-current="page"' : ""}>Docs</a>`;
  return `<header class="nav wrap">
      <a href="${SITE}" aria-label="Norr home" class="nav-logo"><img src="/brand/norr-wordmark.png" alt="Norr" width="56" height="20" /></a>
      <nav aria-label="Main" class="nav-links">
        ${docs}
        <a href="https://app.norr.finance/#/verify" class="muted nav-text">Verify</a>
        <a href="https://github.com/outislabs/norr" class="muted nav-text">GitHub</a>
        <a href="https://app.norr.finance" class="pill pill-solid pill-sm">Open app</a>
        <button type="button" class="menu-btn" popovertarget="menu" aria-label="Menu" aria-controls="menu"><span class="menu-icon" aria-hidden="true"></span></button>
      </nav>
    </header>
    <div id="menu" popover class="menu-sheet">
      <nav aria-label="Menu">
        <a href="/docs/">Docs</a>
        <a href="https://app.norr.finance/#/verify">Verify</a>
        <a href="https://github.com/outislabs/norr">GitHub</a>
      </nav>
    </div>`;
}

const footer = `<footer class="footer">
      <div class="footer-inner wrap">
        <img src="/brand/norr-wordmark.png" alt="Norr" width="45" height="16" />
        <div class="footer-stack">NEAR Intents · NEAR AI · OutLayer · Phala</div>
        <div class="footer-links">
          <a href="/docs/" class="muted">Docs</a>
          <a href="https://github.com/outislabs/norr" class="muted">GitHub</a>
          <a href="https://x.com/norrfi" class="muted">X</a>
          <a href="https://app.norr.finance" class="muted">App</a>
        </div>
      </div>
    </footer>`;

function sideNav(current: string, label: string): string {
  return `<nav aria-label="${label}" class="docs-nav"><ul>${PAGES.map((p) => `<li><a href="${href(p.slug)}"${p.slug === current ? ' aria-current="page"' : ""}>${esc(p.nav)}</a></li>`).join("")}</ul></nav>`;
}

export function pageHtml(p: DocPage, md: string): string {
  const title = titleOf(md);
  const i = PAGES.indexOf(p);
  const prev = PAGES[i - 1];
  const next = PAGES[i + 1];
  const url = `${SITE}${href(p.slug)}`;
  const pager = `<nav class="docs-pager" aria-label="Previous and next page">${prev ? `<a href="${href(prev.slug)}" rel="prev"><span>Previous</span>${esc(prev.nav)}</a>` : "<span></span>"}${next ? `<a href="${href(next.slug)}" rel="next" class="next"><span>Next</span>${esc(next.nav)}</a>` : ""}</nav>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(p.slug ? `${title} · Norr docs` : "Norr docs")}</title>
    <meta name="description" content="${esc(p.description)}" />
    <meta name="theme-color" content="#000000" />
    <link rel="canonical" href="${url}" />
    <link rel="alternate" type="text/markdown" href="${href(p.slug)}index.md" title="This page as Markdown" />
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${url}" />
    <meta property="og:title" content="${esc(title)} · Norr docs" />
    <meta property="og:description" content="${esc(p.description)}" />
    <meta property="og:image" content="${SITE}/brand/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="@norrfi" />
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body class="docs">
    ${header("docs")}
    <div class="docs-layout wrap">
      <aside class="docs-side">${sideNav(p.slug, "Documentation")}</aside>
      <main id="content" class="docs-main">
        <details class="docs-mobile-nav"><summary>Documentation: ${esc(p.nav)}</summary>${sideNav(p.slug, "Documentation pages")}</details>
        <article class="prose">
${renderMarkdown(md)}
        </article>
        ${pager}
      </main>
    </div>
    ${footer}
  </body>
</html>
`;
}

/** Write the HTML pages where Vite picks them up as inputs (root/docs/...), and return their paths. */
export function writePages(root: string): Record<string, string> {
  const content = join(root, "content/docs");
  const out = join(root, "docs");
  rmSync(out, { recursive: true, force: true });
  const inputs: Record<string, string> = {};
  for (const p of PAGES) {
    const dir = join(out, p.slug);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "index.html");
    writeFileSync(file, pageHtml(p, readSource(content, p)));
    inputs[`docs-${p.slug || "index"}`] = file;
  }
  return inputs;
}

/** llms.txt (https://llmstxt.org): what Norr is, and links to every page as Markdown. */
export function llmsTxt(): string {
  const intro = `# Norr

> Norr is a private trading layer for AI agents. An agent connects over MCP with a token scoped to one vault and trades crypto and tokenized US stocks through NEAR Intents, in the Confidential Intents layer when the vault holds its funds there. Rules and a scam check are enforced by the Norr service, which runs in an attested Intel TDX enclave on Phala. Keys stay with OutLayer's custody: the agent's token cannot withdraw, change rules or choose a destination.

- Dashboard: https://app.norr.finance (owners sign in with a NEAR wallet)
- MCP: nine tools (list_assets, check_asset, get_market_data, get_quote, trade, get_portfolio, get_pnl, get_policy, get_activity) at https://mcp.norr.finance/mcp (streamable HTTP, \`Authorization: Bearer <agent token>\`; TLS terminates inside the attested CVM), or stdio from the repository
- REST API: https://api.norr.finance (OpenAPI: https://norr.finance/openapi.json), same bearer token
- Verify: https://app.norr.finance/#/verify runs seven attestation checks in the browser, no account needed; scripts/verify-domain.mts checks that api. and mcp.norr.finance serve certificates held inside the attested CVM
- Source and evidence: https://github.com/outislabs/norr (start with AGENTS.md; \`pnpm judge\` checks every claim in mock mode)
- Status: hackathon build, unaudited, small balances; the hosted service runs on demand

## Docs
`;
  const docs = PAGES.filter((p) => p.slug).map((p) => `- [${p.nav}](${SITE}/docs/${p.slug}/index.md): ${p.description}`).join("\n");
  return `${intro}\n${docs}\n\n## Optional\n\n- [All documentation in one file](${SITE}/llms-full.txt)\n- [Overview](${SITE}/docs/index.md)\n`;
}

/** llms-full.txt: every page's Markdown, in order, each with its URL. */
export function llmsFullTxt(contentDir: string): string {
  const parts = PAGES.map((p) => `<!-- ${SITE}${href(p.slug)} -->\n\n${readSource(contentDir, p).trim()}\n`);
  return `# Norr documentation (all pages)\n\nSource: ${SITE}/docs/ . Generated from the same Markdown as the pages.\n\n---\n\n${parts.join("\n---\n\n")}`;
}
