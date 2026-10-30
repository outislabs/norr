import type { Policy, TradeRequest } from "@norr/shared";
import type { Asset } from "@norr/shared";
import { block, type Block, type VaultState } from "./types";

/** What the agent is trading, after resolution. */
export interface PolicyTarget {
  class: Asset["class"];
  ticker: string;
  symbol: string;
}

const inList = (list: string[], v: string) => list.some((x) => x.toUpperCase() === v.toUpperCase());

/**
 * Per-vault rules, checked in a fixed order. Sells are never blocked by the loss cap or the
 * equity limit, so an agent can always reduce risk.
 */
export function evaluatePolicy(
  policy: Policy,
  req: Pick<TradeRequest, "side" | "amountUsd">,
  target: PolicyTarget,
  state: VaultState,
  nowMs: number,
): Block | null {
  const buying = req.side === "buy";

  if (policy.paused) return block("PAUSED", "This vault is paused by its owner. No trades are allowed until it is resumed.");

  if (req.amountUsd > policy.maxTradeUsd) {
    return block("OVER_TRADE_LIMIT", `$${req.amountUsd} is over this vault's per-trade limit of $${policy.maxTradeUsd}. Try a smaller amount.`);
  }

  if (buying && state.realizedLossTodayUsd >= policy.dailyLossCapUsd) {
    return block("DAILY_LOSS_CAP", `The daily loss cap of $${policy.dailyLossCapUsd} has been reached. Buying resumes tomorrow; selling is still allowed.`);
  }

  if (policy.cooldownSec > 0 && state.lastTradeAtMs !== null) {
    const waitSec = Math.ceil((state.lastTradeAtMs + policy.cooldownSec * 1000 - nowMs) / 1000);
    if (waitSec > 0) return block("COOLDOWN", `Cooling down after the last trade. Try again in ${waitSec}s.`);
  }

  if (target.class === "equity") {
    if (!inList(policy.allowedEquities, target.ticker)) {
      return block("ASSET_NOT_ALLOWED", `${target.ticker} is not in this vault's allowed equities.`);
    }
    if (buying) {
      const total = state.portfolioValueUsd;
      const pct = total > 0 ? ((state.equityValueUsd + req.amountUsd) / total) * 100 : Number.POSITIVE_INFINITY;
      if (pct > policy.maxEquityPct) {
        const shown = Number.isFinite(pct) ? `${pct.toFixed(1)}%` : "an undefined share of an empty vault";
        return block("EQUITY_LIMIT", `This buy would put ${shown} of the vault in equities; the limit is ${policy.maxEquityPct}%.`);
      }
    }
  } else if (policy.allowedCrypto !== "any_safe" && !inList(policy.allowedCrypto, target.symbol)) {
    return block("ASSET_NOT_ALLOWED", `${target.symbol} is not in this vault's allowed crypto list.`);
  }

  return null;
}
