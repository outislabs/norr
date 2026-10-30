/**
 * How the Shield incident check behaves when the feed cannot be read.
 *
 * Default and only production behavior: fail closed. A dev-only bypass exists so live trades can
 * be tried while a SHIELD key is pending. It needs BOTH `SHIELD_MODE=dev-bypass` AND an explicit
 * `NORR_ENV=dev`; an unset `NORR_ENV` counts as production, and "demo" and "production" always
 * refuse it. It only covers an unreachable feed: a feed that reports an incident still blocks.
 */
export type ShieldOnUnavailable = "block" | "allow";

export interface ShieldMode {
  onUnavailable: ShieldOnUnavailable;
  /** True only for the dev bypass. */
  bypass: boolean;
}

export function resolveShieldMode(env: NodeJS.ProcessEnv): ShieldMode {
  const mode = env.SHIELD_MODE ?? "enforce";
  if (mode === "enforce") return { onUnavailable: "block", bypass: false };
  if (mode !== "dev-bypass") throw new Error(`unknown SHIELD_MODE "${mode}" (use "enforce", or "dev-bypass" in a dev environment only)`);
  if (env.NORR_ENV !== "dev") {
    throw new Error(
      `SHIELD_MODE=dev-bypass is only allowed when NORR_ENV=dev (NORR_ENV is ${env.NORR_ENV ? `"${env.NORR_ENV}"` : "unset, which counts as production"}). It is never allowed in demo or production.`,
    );
  }
  return { onUnavailable: "allow", bypass: true };
}

/** Mock mode is the demo: it must never run with a bypass requested. */
export function assertNoBypassInMock(env: NodeJS.ProcessEnv): void {
  const mode = env.SHIELD_MODE ?? "enforce";
  if (mode !== "enforce") throw new Error(`SHIELD_MODE=${mode} is not allowed in mock/demo mode`);
}

export const BYPASS_BANNER = [
  "################################################################",
  "# SHIELD BYPASS ACTIVE (SHIELD_MODE=dev-bypass, NORR_ENV=dev)  #",
  "# Trades are allowed when the Shield incident feed is down.     #",
  "# Dev only. Never use in demo or production.                    #",
  "################################################################",
].join("\n");

export const bypassWarning = (vaultId: string): string =>
  `[norr] WARNING SHIELD BYPASS: vault ${vaultId} was evaluated WITHOUT the Shield incident feed (dev-bypass is on)`;
