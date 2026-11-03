import { useMemo, useState } from "react";
import { PublicFrame, Shell } from "./components/Shell";
import { createApi, type SessionInfo } from "./lib/api";
import { parseRoute, useHashPath } from "./lib/route";
import { clearSession, loadSession, saveSession } from "./lib/session";
import { SignInPage } from "./pages/SignInPage";
import { VaultPage } from "./pages/VaultPage";
import { VaultsPage } from "./pages/VaultsPage";
import { VerifyPage } from "./pages/VerifyPage";

export function App({ base = "/api", mcpUrl = "http://127.0.0.1:8788/mcp" }: { base?: string; mcpUrl?: string }) {
  const [session, setSession] = useState(() => loadSession());
  const [version, setVersion] = useState(0);
  const path = useHashPath();
  const api = useMemo(
    () =>
      createApi({
        base,
        getToken: () => loadSession()?.token ?? null,
        onUnauthorized: () => {
          clearSession();
          setSession(null);
        },
      }),
    [base],
  );

  // The enclave's proof is public, so the Verify screen works without signing in (the landing page links straight to it).
  if (!session && parseRoute(path).name === "verify") {
    return (
      <PublicFrame>
        <VerifyPage api={api} signedIn={false} />
      </PublicFrame>
    );
  }
  if (!session) {
    return (
      <SignInPage
        api={api}
        onSession={(s: SessionInfo) => {
          saveSession(s);
          setSession(s);
        }}
      />
    );
  }
  const route = parseRoute(path);
  return (
    <Shell
      api={api}
      version={version}
      account={session.accountId}
      route={path}
      onSignOut={() => {
        void api.logout().catch(() => undefined);
        clearSession();
        setSession(null);
      }}
      onPauseAll={async () => {
        await api.pauseAll();
        setVersion((v) => v + 1);
      }}
    >
      {route.name === "vaults" && <VaultsPage api={api} account={session.accountId} version={version} />}
      {route.name === "vault" && <VaultPage key={`${route.id}-${version}`} api={api} account={session.accountId} id={route.id} tab={route.tab} mcpUrl={mcpUrl} apiUrl={base.startsWith("http") ? base : "http://localhost:8787"} onChanged={() => setVersion((v) => v + 1)} />}
      {route.name === "verify" && <VerifyPage api={api} signedIn />}
    </Shell>
  );
}
