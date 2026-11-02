export interface OnboardingInput {
  /** Total value across both layers, or null when balances could not be read. */
  totalUsd: number | null;
  /** The owner created an agent token through the dashboard (remembered in this browser). */
  tokenIssued: boolean;
  /** The agent has traded, or tried to, so it is plainly connected. */
  hasActivity: boolean;
  rulesReviewed: boolean;
}

export interface Step {
  id: "vault" | "fund" | "connect" | "rules";
  title: string;
  detail: string;
  done: boolean;
  /** Hash route tab to open for this step. */
  tab: "overview" | "fund" | "connect" | "rules";
}

/** The first-run checklist. Order is the order to do things in; `done` never depends on the previous step. */
export function onboardingSteps(i: OnboardingInput): Step[] {
  return [
    { id: "vault", title: "Vault created", detail: "Your vault and its custody wallet exist.", done: true, tab: "overview" },
    { id: "fund", title: "Fund it", detail: "Send a little USDC, from any chain. Start small.", done: (i.totalUsd ?? 0) > 0, tab: "fund" },
    { id: "rules", title: "Check the rules", detail: "Largest trade, daily caps, which assets. The agent cannot change these.", done: i.rulesReviewed, tab: "rules" },
    { id: "connect", title: "Connect your agent", detail: "Create a token and paste the config into your agent.", done: i.tokenIssued || i.hasActivity, tab: "connect" },
  ];
}

export const allDone = (steps: Step[]): boolean => steps.every((s) => s.done);
