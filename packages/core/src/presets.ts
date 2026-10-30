import type { Policy } from "@norr/shared";

export type PresetName = "cautious" | "balanced" | "degen";

const MAJORS = ["BTC", "ETH", "SOL", "NEAR", "USDC", "USDT"];
const INDEXES = ["SPY", "QQQ"];
const LARGE_CAPS = ["NVDA", "TSLA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "SPY", "QQQ"];

/**
 * Starting points for a vault's rules. Equities still need the owner's non-US confirmation
 * (`nonUsConfirmed`), which no preset sets.
 */
export function presetPolicy(name: PresetName, vaultId: string): Policy {
  const base = { vaultId, paused: false, nonUsConfirmed: false };
  switch (name) {
    case "cautious":
      return { ...base, maxTradeUsd: 25, dailyLossCapUsd: 10, maxEquityPct: 20, allowedCrypto: MAJORS, allowedEquities: INDEXES, cooldownSec: 300, allowMediumRisk: false };
    case "balanced":
      return { ...base, maxTradeUsd: 50, dailyLossCapUsd: 25, maxEquityPct: 60, allowedCrypto: "any_safe", allowedEquities: LARGE_CAPS, cooldownSec: 10, allowMediumRisk: false };
    case "degen":
      return { ...base, maxTradeUsd: 200, dailyLossCapUsd: 100, maxEquityPct: 100, allowedCrypto: "any_safe", allowedEquities: [...LARGE_CAPS, "CRCL", "HOOD"], cooldownSec: 0, allowMediumRisk: true };
  }
}
