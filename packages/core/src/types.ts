import type { BlockCode } from "@norr/shared";

/** A failed gate. `message` is plain language, safe to show to the agent. */
export interface Block {
  ok: false;
  code: BlockCode;
  message: string;
}

export const block = (code: BlockCode, message: string): Block => ({ ok: false, code, message });

/** Per-vault state the policy needs. Supplied by the enclave; core does no I/O. */
export interface VaultState {
  realizedLossTodayUsd: number;
  lastTradeAtMs: number | null;
  portfolioValueUsd: number;
  equityValueUsd: number;
}
