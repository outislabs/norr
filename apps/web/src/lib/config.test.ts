import { describe, expect, it } from "vitest";
import { resolveApiBase, resolveMcpUrl } from "./config";

describe("resolveApiBase", () => {
  it("defaults to the same-origin proxy and trims trailing slashes", () => {
    expect(resolveApiBase(undefined)).toBe("/api");
    expect(resolveApiBase("  ")).toBe("/api");
    expect(resolveApiBase("https://norr.example.phala.network/")).toBe("https://norr.example.phala.network");
    expect(resolveApiBase("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("refuses a remote service over plain http, and anything that is not a URL", () => {
    expect(() => resolveApiBase("http://norr.example.com")).toThrow(/https/);
    expect(() => resolveApiBase("norr.example.com")).toThrow(/not a URL/);
  });
});

describe("resolveMcpUrl", () => {
  it("uses the explicit URL, derives the Phala one from the service URL, and falls back to localhost", () => {
    expect(resolveMcpUrl("https://mcp.example.com/mcp/", "/api")).toBe("https://mcp.example.com/mcp");
    expect(resolveMcpUrl(undefined, "https://abc123-8787.dstack-pha-prod5.phala.network")).toBe("https://abc123-8788.dstack-pha-prod5.phala.network/mcp");
    expect(resolveMcpUrl("", "/api")).toBe("http://127.0.0.1:8788/mcp");
  });

  it("refuses a remote endpoint over plain http", () => {
    expect(() => resolveMcpUrl("http://mcp.example.com/mcp", "/api")).toThrow(/https/);
  });
});
