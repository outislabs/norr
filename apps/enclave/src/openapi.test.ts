import { BlockCode } from "@norr/shared";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMockEnclave } from "./mock-enclave";

// The OpenAPI spec is hand-written; these tests keep it honest: same routes as the service, and every real response
// from mock mode validates against the schema the spec gives for it.
const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, "../openapi.json"), "utf8"));
type Schema = Record<string, unknown>;

const resolve = (s: Schema): Schema => (typeof s.$ref === "string" ? resolve(s.$ref.split("/").slice(1).reduce((o: Schema, k) => o[k] as Schema, spec)) : s);

/** A small validator for the subset of JSON Schema the spec uses. Returns the first problem, or null. */
function problem(value: unknown, schema: Schema, path = "$"): string | null {
  const s = resolve(schema);
  if (s.oneOf) {
    const ok = (s.oneOf as Schema[]).filter((x) => problem(value, x, path) === null);
    return ok.length >= 1 ? null : `${path}: matches no oneOf option`;
  }
  if ("const" in s && value !== s.const) return `${path}: expected ${JSON.stringify(s.const)}`;
  if (s.enum && !(s.enum as unknown[]).includes(value)) return `${path}: ${JSON.stringify(value)} not in enum`;
  const types = s.type === undefined ? null : ([] as string[]).concat(s.type as string | string[]);
  if (types) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) && types.includes("integer") ? "integer" : typeof value;
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) return `${path}: expected ${types.join("|")}, got ${actual}`;
  }
  if (Array.isArray(value) && s.items) for (const [i, v] of value.entries()) {
    const p = problem(v, s.items as Schema, `${path}[${i}]`);
    if (p) return p;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of (s.required as string[] | undefined) ?? []) if (!(k in value)) return `${path}: missing ${k}`;
    for (const [k, sub] of Object.entries((s.properties as Record<string, Schema>) ?? {})) {
      if (k in value) {
        const p = problem((value as Record<string, unknown>)[k], sub, `${path}.${k}`);
        if (p) return p;
      }
    }
  }
  return null;
}

const schemaFor = (path: string, method: string) => spec.paths[path][method].responses["200"].content["application/json"].schema as Schema;

describe("openapi.json", () => {
  it("documents exactly the routes the service serves to agents and the public", () => {
    const src = readFileSync(join(here, "app.ts"), "utf8");
    const served = [...src.matchAll(/app\.(get|post)\("(\/v1\/[^"]+|\/health|\/attestation|\/info)"/g)].map(([, m, p]) => `${m!.toUpperCase()} ${p}`).sort();
    const documented = Object.entries(spec.paths as Record<string, Record<string, unknown>>).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)).sort();
    expect(documented).toEqual(served);
  });

  it("the validator itself rejects what the spec does not allow", () => {
    const decision = spec.components.schemas.Decision as Schema;
    expect(problem({ status: "executed" }, decision)).not.toBeNull(); // no fill
    expect(problem({ status: "blocked", code: "MADE_UP", message: "x" }, decision)).not.toBeNull();
    expect(problem({ status: "blocked", code: "PAUSED", message: "x" }, decision)).toBeNull();
    expect(problem({ holdings: [], totalUsd: "1", byClass: { crypto: 0, equity: 0 } }, spec.components.schemas.Portfolio as Schema)).not.toBeNull();
  });

  it("lists the same block codes as the service", () => {
    expect(spec.components.schemas.BlockCode.enum).toEqual(BlockCode.options);
  });

  it("every response from mock mode validates against its documented schema", async () => {
    const t0 = Date.UTC(2026, 10, 3, 12);
    const clock = { t: t0 };
    const m = createMockEnclave({ now: () => clock.t });
    m.deps.sleep = async (ms) => { clock.t += ms; };
    m.deps.settle = { waitMs: 0, intervalMs: 1 };
    const call = async (path: string, body?: unknown) => (await m.app.request(path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${m.agentToken}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();
    const check = (value: unknown, path: string, method = "get") => expect(problem(value, schemaFor(path, method)), `${method.toUpperCase()} ${path}`).toBeNull();

    check(await call("/health"), "/health");
    check(await call("/v1/assets"), "/v1/assets");
    check(await call("/v1/assets/check?asset=RUGPULL"), "/v1/assets/check");
    check(await call("/v1/assets/check?asset=NVDA"), "/v1/assets/check");
    check(await call("/v1/assets/check?asset=NOPE"), "/v1/assets/check");
    check(await call("/v1/market?asset=SOL"), "/v1/market");
    check(await call("/v1/market?asset=NVDA"), "/v1/market");
    check(await call("/v1/quote", { side: "buy", asset: "SOL", amountUsd: 5 }), "/v1/quote", "post");
    check(await call("/v1/quote", { side: "buy", asset: "TSLA", amountUsd: 500 }), "/v1/quote", "post");
    check(await call("/v1/trade", { side: "buy", asset: "NVDA", amountUsd: 40, reason: "spec" }), "/v1/trade", "post");
    check(await call("/v1/trade", { side: "buy", asset: "RUGPULL", amountUsd: 5 }), "/v1/trade", "post");
    clock.t += 60_000;
    check(await call("/v1/trade", { side: "sell", asset: "NVDA", amountUsd: 10 }), "/v1/trade", "post");
    check(await call("/v1/portfolio"), "/v1/portfolio");
    check(await call("/v1/policy"), "/v1/policy");
    check(await call("/v1/pnl"), "/v1/pnl");
    check(await call("/v1/activity"), "/v1/activity");
  });
});
