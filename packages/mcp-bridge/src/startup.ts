import { DEFAULT_MCP_URL } from "./bridge.js";

/**
 * What the CLI says before it starts, and whether it starts at all. Pure, so it is tested without a terminal.
 *
 * The bridge is meant to be launched by an MCP client (Claude Desktop, Cursor, Claude Code...) over stdio. Someone who
 * runs `npx @norrfi/mcp` by hand sees either an explanation (no token) or one line saying it waits for a client (with a
 * token, in an interactive terminal). Everything goes to stderr: stdout carries the MCP protocol.
 */

export const CONNECTOR_HELP =
  "Norr MCP connector. This isn't run on its own: add it to your AI app (Claude Desktop, Cursor, Claude Code…) using the snippet from your vault's Connect tab at app.norr.finance. " +
  `Using the Claude app or claude.ai? Add ${DEFAULT_MCP_URL} as a connector instead — no token needed.`;

export const WAITING_LINE = "norr-mcp: waiting for an MCP client on stdin. Your AI app starts this connector itself; press Ctrl+C to quit.";

export interface StartupInput {
  token: string | undefined;
  /** stdin is an interactive terminal: a person ran it, not an MCP client. */
  interactive: boolean;
}

export type Startup = { start: false; exitCode: number; stderr: string[] } | { start: true; stderr: string[] };

export function startup(i: StartupInput): Startup {
  const token = i.token?.trim();
  if (!token) {
    // Run by hand: just explain. Started by an app whose config lacks the token: say that first.
    return { start: false, exitCode: 1, stderr: i.interactive ? [CONNECTOR_HELP] : [`norr-mcp: NORR_AGENT_TOKEN is missing from this app's MCP config. ${CONNECTOR_HELP}`] };
  }
  return { start: true, stderr: i.interactive ? [WAITING_LINE] : [] };
}
