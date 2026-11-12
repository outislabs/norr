import { minSellUsd, NEGLIGIBLE_USD, topUpUsd } from "@norr/core";
import type { Decision, TradeRequest } from "@norr/shared";
import { executeTrade, positionOf, refreshState, venueOrder, type TradeDeps } from "./trade";

/**
 * "Top up and sell all": the way out of a stock position too small to sell (NEAR Intents solvers do not quote below the
 * ticker's minimum, so after a price drop a position can get stuck). Buys just enough of the same token, then sells the
 * whole position. Both are ordinary trades through executeTrade, so the vault's rules, daily caps, cooldown and owner
 * approvals apply to each. Safe to call again: a position already above the minimum goes straight to the sell.
 *
 * The other way out, withdrawing the tokens to the owner's wallet, is owner-only and uses the existing withdraw flow.
 */

export interface ExitStep {
  step: "top_up" | "sell_all";
  usd: number;
  decision: Decision;
}

export interface ExitResult {
  /** done: sold; waiting: a step waits for the owner (call again once it has run); stopped: a step did not run. */
  status: "done" | "waiting" | "stopped";
  steps: ExitStep[];
  message: string;
}

const money = (n: number) => n.toFixed(2);

export async function exitPosition(deps: TradeDeps, vaultId: string, asset: string, reason: string): Promise<ExitResult> {
  const stopped = (message: string, steps: ExitStep[] = []): ExitResult => ({ status: "stopped", steps, message });
  const vault = deps.vaults.get(vaultId);
  if (!vault) return stopped("This vault does not exist.");
  const found = deps.registry.lookup(asset);
  if (found.kind !== "found" || found.resolution.ambiguous) return stopped(`"${asset}" is not one asset Norr can trade. Name it by ticker, as get_portfolio shows it.`);
  const res = found.resolution;
  const order = venueOrder(vault.policy.privacy);

  const read = async () => positionOf(await refreshState(deps, vault), res.candidates, order);
  let pos = await read().catch(() => null);
  if (!pos || pos.usd < NEGLIGIBLE_USD) return stopped(`The vault holds no ${res.ticker} where this vault's trades run, so there is nothing to sell.`);
  // Trade the exact token held (one issuer), not "the best" across issuers: the point is to empty this position.
  const token = pos.candidate;
  const min = res.class === "equity" ? minSellUsd(res.ticker) : 0;
  const steps: ExitStep[] = [];
  const trade = (r: Omit<TradeRequest, "vaultId" | "asset" | "reason">) => executeTrade(deps, { vaultId, asset: token.id, reason, ...r });

  if (pos.usd < min) {
    const usd = topUpUsd(pos.usd, min);
    const d = await trade({ side: "buy", amountUsd: usd });
    steps.push({ step: "top_up", usd, decision: d });
    if (d.status === "pending_approval") return { status: "waiting", steps, message: `The top-up buy ($${money(usd)} of ${token.symbol}) waits for the owner's approval. Once it has run, call this again to sell the whole position.` };
    if (d.status !== "executed") return stopped(`The top-up buy ($${money(usd)} of ${token.symbol}) did not run, so nothing was sold: ${d.message}`, steps);
    pos = await read().catch(() => null);
    if (!pos || pos.candidate.id !== token.id) return stopped(`The top-up ran, but the new ${token.symbol} balance could not be read. Try selling all again in a minute.`, steps);
  }

  // Sell everything. amountUsd is a ceiling (a little above the position, for price moves), never above the vault's largest trade.
  const ceiling = Math.ceil(pos.usd * 1.05 * 100) / 100;
  if (ceiling > vault.policy.maxTradeUsd && pos.usd > vault.policy.maxTradeUsd) {
    return stopped(`The ${token.symbol} position (about $${money(pos.usd)}) is larger than this vault's largest trade ($${vault.policy.maxTradeUsd}), so it cannot be sold in one trade. Sell part of it first, leaving at least $${money(min)}.`, steps);
  }
  const usd = Math.min(ceiling, vault.policy.maxTradeUsd);
  const d = await trade({ side: "sell", amountUsd: usd, sellAll: true });
  steps.push({ step: "sell_all", usd, decision: d });
  if (d.status === "executed") return { status: "done", steps, message: `Sold the whole ${token.symbol} position.` };
  if (d.status === "pending_approval") return { status: "waiting", steps, message: `The sale of the whole ${token.symbol} position waits for the owner's approval.` };
  // Right after a top-up the vault's cooldown between trades can hold the sale back: not a failure, just later.
  if (d.status === "blocked" && d.code === "COOLDOWN" && steps.length > 1) return { status: "waiting", steps, message: `The top-up ran; the sale waits for the vault's cooldown between trades (${d.message}) Call this again then to sell the whole position.` };
  return stopped(`The sale of the whole ${token.symbol} position did not run: ${d.message}`, steps);
}
