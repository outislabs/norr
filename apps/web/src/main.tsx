import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { resolveApiBase, resolveMcpUrl } from "./lib/config";
import "./styles.css";

const base = resolveApiBase(import.meta.env.VITE_NORR_API_URL as string | undefined);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App base={base} mcpUrl={resolveMcpUrl(import.meta.env.VITE_NORR_MCP_URL as string | undefined, base)} />
  </StrictMode>,
);
