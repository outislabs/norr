#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_MCP_URL, createBridge } from "./bridge.js";

// npx @norrfi/mcp, with NORR_AGENT_TOKEN in the environment (and optionally NORR_MCP_URL).
// Logs go to stderr: stdout carries the MCP protocol.
try {
  const url = process.env.NORR_MCP_URL?.trim() || DEFAULT_MCP_URL;
  const { server } = createBridge({ url, token: process.env.NORR_AGENT_TOKEN?.trim() ?? "" });
  await server.connect(new StdioServerTransport());
  console.error(`norr-mcp: bridging stdio to ${new URL(url).origin}`);
} catch (e) {
  console.error(`norr-mcp: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
