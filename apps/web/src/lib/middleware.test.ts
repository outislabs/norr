import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../../../../functions/_middleware";

/** A minimal stand-in for Cloudflare's HTMLRewriter: appends the handler's HTML at the end of <head>. */
class FakeRewriter {
  private append = "";
  on(_selector: string, h: { element(el: { append(html: string, o: { html: boolean }): void }): void }) {
    h.element({ append: (html) => (this.append += html) });
    return this;
  }
  transform(res: Response): Response {
    const append = this.append;
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(new TextEncoder().encode((await res.text()).replace("</head>", `${append}</head>`)));
        c.close();
      },
    });
    return new Response(body, res);
  }
}

const PAGE = "<!doctype html><html><head><title>x</title></head><body></body></html>";

/** One request through the real Function. `asset` answers /csp-config.json. */
function run(o: { path?: string; html?: boolean; config?: Response | "fail" } = {}) {
  const config = o.config ?? new Response(JSON.stringify({ apiUrl: "https://api.norr.finance" }));
  return onRequest({
    request: new Request(`https://app.norr.finance${o.path ?? "/"}`),
    env: { ASSETS: { fetch: async () => (config === "fail" ? Promise.reject(new Error("no asset")) : config.clone()) } },
    next: async () => (o.html === false ? new Response("console.log(1)", { headers: { "content-type": "text/javascript" } }) : new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } })),
  });
}
const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)![1]!;

beforeEach(() => {
  (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter = FakeRewriter;
});
afterEach(() => {
  delete (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
});

describe("the Pages Function that sets the dashboard's CSP", () => {
  it("puts one nonce in the CSP header and the same one in the page, where the wallet connector reads it", async () => {
    const res = await run();
    const csp = res.headers.get("content-security-policy")!;
    const nonce = nonceOf(csp);
    expect(await res.text()).toContain(`<meta name="norr-csp-nonce" content="${nonce}">`);
    expect(csp).toContain("connect-src 'self' https://api.norr.finance");
    expect(/script-src [^;]*unsafe-inline/.test(csp)).toBe(false); // only style-src carries it (csp.test.ts)
  });

  it("uses a fresh nonce for every response, and the page is never cached (a cached page would reuse one)", async () => {
    const [a, b] = [await run(), await run()];
    expect(nonceOf(a.headers.get("content-security-policy")!)).not.toBe(nonceOf(b.headers.get("content-security-policy")!));
    expect(a.headers.get("cache-control")).toBe("no-store");
  });

  it("other files get the policy and the static headers too, but no nonce meta and no cache change", async () => {
    const res = await run({ path: "/assets/app.js", html: false });
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBeNull();
    expect(await res.text()).toBe("console.log(1)");
  });

  it("fails closed when the build's config cannot be read: no external service origin is allowed", async () => {
    for (const config of ["fail" as const, new Response("nope", { status: 404 })]) {
      // a new module state per case: the config is read once per isolate
      vi.resetModules();
      const { onRequest: fresh } = await import("../../../../functions/_middleware");
      const res: Response = await fresh({
        request: new Request("https://app.norr.finance/"),
        env: { ASSETS: { fetch: async () => (config === "fail" ? Promise.reject(new Error("x")) : config) } },
        next: async () => new Response(PAGE, { headers: { "content-type": "text/html" } }),
      });
      const connect = /connect-src ([^;]*)/.exec(res.headers.get("content-security-policy")!)![1]!;
      expect(connect).not.toContain("api.norr.finance");
      expect(connect.startsWith("'self'")).toBe(true);
    }
  });
});
