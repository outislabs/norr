// Read-only: which real, routable tokens does Scam Shield score as high risk? Picks the demo's "rug" beat.
// Uses the same registry and risk provider as the service; sends no quote and moves nothing.
//   pnpm exec tsx scripts/rug-scan.mts [--limit 150]
import { HeuristicRiskProvider, Registry } from "../packages/core/src";
import { DexScreenerSignals, OneClick } from "../packages/intents/src";

const limit = Number(process.argv[process.argv.indexOf("--limit") + 1]) || 150;
const plain = await new OneClick({}).tokens(false);
const registry = new Registry({ crypto: plain });
const risk = new HeuristicRiskProvider(new DexScreenerSignals().signals);
const all = registry.entries("crypto");
// Unique symbols, cheapest first: rugs are tiny-priced; majors are skipped by the provider anyway.
const bySymbol = new Map(all.map((e) => [e.symbol, e]));
const pool = [...bySymbol.values()].slice(0, limit);
const out: { symbol: string; chain: string; score: number; reasons: string[] }[] = [];
let i = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (i < pool.length) {
    const e = pool[i++]!;
    try {
      const r = await risk.assess(e);
      out.push({ symbol: e.symbol, chain: e.chain, score: r.score, reasons: r.reasons });
    } catch {
      /* data source unavailable for this token */
    }
  }
}));
out.sort((a, b) => b.score - a.score);
console.log(`scored ${out.length} of ${all.length} routable crypto assets (${pool.length} unique symbols tried)`);
for (const r of out.filter((x) => x.score >= 65).slice(0, 12)) console.log(`HIGH ${String(r.score).padStart(3)} ${r.symbol.padEnd(10)} ${r.chain.padEnd(8)} ${r.reasons.join("; ").slice(0, 150)}`);
const counts = { high: out.filter((x) => x.score >= 65).length, medium: out.filter((x) => x.score >= 35 && x.score < 65).length, low: out.filter((x) => x.score < 35).length };
console.log(counts);
