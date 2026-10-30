import { useMemo, useState } from "react";
import { Shell } from "./components/Shell";
import { createApi, type SessionInfo } from "./lib/api";
import { parseRoute, useHashPath } from "./lib/route";
import { clearSession, loadSession, saveSession } from "./lib/session";
import { SignInPage } from "./pages/SignInPage";
import { VaultPage } from "./pages/VaultPage";
import { VaultsPage } from "./pages/VaultsPage";
import { VerifyPage } from "./pages/VerifyPage";

export function App({ base = "/api" }: { base?: string }) {
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
      {route.name === "vault" && <VaultPage key={`${route.id}-${version}`} api={api} account={session.accountId} id={route.id} tab={route.tab} onChanged={() => setVersion((v) => v + 1)} />}
      {route.name === "verify" && <VerifyPage api={api} />}
    </Shell>
  );
}
