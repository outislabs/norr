import { describe, expect, it } from "vitest";
import { apiOrigin, buildCsp, headersFile } from "./csp";

const directive = (csp: string, name: string): string[] => csp.split("; ").find((d) => d.startsWith(`${name} `))!.split(" ").slice(1);
const SERVICE = "https://api.norr.finance";

describe("dashboard CSP", () => {
  it("allows exactly the configured service origin, not its path", () => {
    expect(apiOrigin(`${SERVICE}/`)).toBe(SERVICE);
    expect(directive(buildCsp(SERVICE), "connect-src")).toContain(SERVICE);
    expect(directive(buildCsp(undefined), "connect-src")).not.toContain(SERVICE);
  });

  it("has no inline or eval escape hatches and cannot be framed", () => {
    const csp = buildCsp(SERVICE);
    expect(csp).not.toMatch(/unsafe-inline|[^-]'unsafe-eval'|\*/);
    expect(directive(csp, "script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]); // WebAssembly only, never JS eval
    expect(directive(csp, "style-src")).toEqual(["'self'"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
  });

  it("lets the HOT wallet widget, the NEAR RPC and the certificate cache through, and nothing sends the quote to Phala", () => {
    const csp = buildCsp(SERVICE);
    expect(directive(csp, "frame-src")).toEqual(["https://hot-labs.org"]);
    expect(directive(csp, "connect-src")).toEqual(expect.arrayContaining(["https://h4n.app", "https://free.rpc.fastnear.com"]));
    expect(csp).not.toContain("cloud-api.phala.network");
    expect(directive(csp, "connect-src")).toContain("https://pccs.phala.network"); // Intel-signed collateral for the in-browser check
    expect(directive(csp, "connect-src")).toContain("https://api.outlayer.ai"); // approvals read and voted on directly
  });

  it("writes a Pages _headers file that keeps the existing headers", () => {
    const h = headersFile(SERVICE);
    expect(h.startsWith("/*\n")).toBe(true);
    for (const line of ["X-Frame-Options: DENY", "Referrer-Policy: no-referrer", "X-Content-Type-Options: nosniff", "Permissions-Policy: camera=(), microphone=(), geolocation=()", `Content-Security-Policy: ${buildCsp(SERVICE)}`]) {
      expect(h).toContain(`  ${line}`);
    }
  });
});
