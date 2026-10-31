import { describe, expect, it } from "vitest";
import { resolveApiBase } from "./config";

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
