import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EnclaveClient } from "./client";
import { createNorrServer } from "./tools";

// stdout carries the protocol, so diagnostics go to stderr and never include the token.
const token = process.env.NORR_AGENT_TOKEN;
if (!token) {
  console.error("norr-mcp: set NORR_AGENT_TOKEN to your vault's agent token (and NORR_API_URL if the service is not on http://localhost:8787).");
  process.exit(1);
}

const client = new EnclaveClient({ baseUrl: process.env.NORR_API_URL ?? "http://localhost:8787", token });
await createNorrServer(client).connect(new StdioServerTransport());
console.error("norr-mcp: ready on stdio");
