import { serve } from "@hono/node-server";
import { buildLive } from "./live";
import { createMockEnclave } from "./mock-enclave";
import { assertNoBypassInMock } from "./shield-mode";

const port = Number(process.env.PORT ?? 8787);

if (process.env.NORR_MOCK === "1") {
  assertNoBypassInMock(process.env);
  // Mock only: NORR_MOCK_AGENT_TOKEN pins the demo token so a Claude Desktop config survives restarts.
  const m = createMockEnclave({ agentToken: process.env.NORR_MOCK_AGENT_TOKEN || undefined });
  serve({ fetch: m.app.fetch, port });
  console.log(`Norr (MOCK mode, no funds, no network) listening on http://localhost:${port}`);
  console.log(`  agent token : ${m.agentToken}`);
  console.log(`  admin token : ${m.adminToken}   (dev-only: POST /owner/vaults/demo/pause)`);
  console.log(`  try         : curl -H "Authorization: Bearer ${m.agentToken}" http://localhost:${port}/v1/policy`);
} else {
  const live = await buildLive();
  serve({ fetch: live.app.fetch, port });
  console.log(`Norr (LIVE rails) listening on http://localhost:${port}`);
  console.log(`  vault: ${live.vaultId}`);
  console.log(`  agent token (shown once): ${live.agentToken}`);
  if (!live.shieldConfigured && !live.shieldBypass) console.warn("  warning: SHIELD_API_KEY not set, so the Shield check fails closed and every trade is blocked");
  if (live.shieldBypass) console.warn("  SHIELD BYPASS is ON (dev only). Every trade will log a warning.");
}
