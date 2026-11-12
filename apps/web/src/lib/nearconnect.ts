import type { NearConnector } from "@hot-labs/near-connect";

/**
 * The dashboard's wallet connection: NEAR Connect (@hot-labs/near-connect), configured the way a dashboard that signs
 * approvals and a custody policy has to configure it.
 *
 * - **Pinned wallets, served from this origin.** The library loads a manifest and each wallet's executor script at
 *   runtime and runs them in a sandboxed iframe inside the page. Left alone, that is live code from ten third-party
 *   hosts. Here the manifest and executors are our own pinned copies (`public/near-connect`, SHA-256 in `lock.json`).
 * - **No custom wallets.** The picker has a settings panel where anyone can paste a manifest and register a wallet with
 *   any executor URL, and the library remembers it. That is disabled, and any remembered one is ignored.
 * - **No auto-connect.** By default the library registers and connects a wallet when any window posts it a message.
 *   Sign-in here only happens from the owner's click, and only with a wallet from the pinned manifest.
 * - **CSP nonce.** Wallet frames are inline scripts; the page's CSP allows them only with the per-request nonce the
 *   Pages Function put in the page (see functions/_middleware.ts).
 */

export const MANIFEST_URL = "/near-connect/manifest.json";
/** The library's own localStorage keys (it does not prefix them). */
const SELECTED_KEY = "selected-wallet";
const CUSTOM_WALLETS_KEY = "debug-wallets";

export const CUSTOM_WALLETS_OFF = "Custom wallets are turned off in the Norr dashboard. Choose a wallet from the list.";

export interface WalletAccount {
  accountId: string;
  publicKey?: string;
}
export interface SignedMessage {
  accountId: string;
  publicKey: string;
  signature: string;
}
export interface SignMessageArgs {
  message: string;
  recipient: string;
  nonce: Uint8Array;
}
/** A function call, in NEAR Connect's own action format (no near-api-js needed). */
export interface FunctionCallAction {
  type: "FunctionCall";
  params: { methodName: string; args: object; gas: string; deposit: string };
}
export interface TransactionArgs {
  receiverId: string;
  signerId?: string;
  actions: FunctionCallAction[];
}

/** One connected wallet, as the dashboard uses it. */
export interface WalletHandle {
  id: string;
  name: string;
  signMessage(a: SignMessageArgs): Promise<SignedMessage>;
  signAndSendTransaction(a: TransactionArgs): Promise<unknown>;
}

/** What the dashboard needs from the wallet connection. Tests supply a fake. */
export interface Kit {
  /** The wallets offered: those in the pinned manifest that can sign a message. Empty when the list did not load. */
  offered(): Promise<{ id: string; name: string; signsInOneStep: boolean }[]>;
  /** Show the picker. Resolves with the chosen wallet's id; rejects if the owner closes it. */
  select(): Promise<string>;
  /** Connect the wallet (account only). */
  signIn(id: string): Promise<{ wallet: WalletHandle; accounts: WalletAccount[] }>;
  /** Connect the wallet and sign the message in the same wallet interaction. */
  signInAndSign(id: string, a: SignMessageArgs): Promise<{ wallet: WalletHandle; signed: SignedMessage }>;
  /** The connected wallet and its accounts. Rejects when no wallet is connected. */
  connected(): Promise<{ wallet: WalletHandle; accounts: WalletAccount[] }>;
  /** Sign out of the wallet and forget it. Never throws. */
  disconnect(): Promise<void>;
}

type Wallet = Awaited<ReturnType<NearConnector["wallet"]>>;

const wrap = (w: Wallet): WalletHandle => ({
  id: w.manifest.id,
  name: w.manifest.name,
  signMessage: (a) => w.signMessage({ ...a, network: "mainnet" }),
  signAndSendTransaction: (a) => w.signAndSendTransaction({ ...a, network: "mainnet" }),
});

/** localStorage that cannot throw (Safari private mode) and never hands back the library's remembered custom wallets. */
export function guardedStorage(ls: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage) {
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  return {
    get: async (k: string): Promise<string | null> => (k === CUSTOM_WALLETS_KEY ? null : safe(() => ls.getItem(k), null)),
    set: async (k: string, v: string): Promise<void> => {
      if (k !== CUSTOM_WALLETS_KEY) safe(() => ls.setItem(k, v), undefined);
    },
    remove: async (k: string): Promise<void> => safe(() => ls.removeItem(k), undefined),
  };
}

/** The per-request nonce the Pages Function put in the page, or undefined (local development has no CSP). */
export function readCspNonce(doc: Document = document): string | undefined {
  return doc.querySelector('meta[name="norr-csp-nonce"]')?.getAttribute("content") || undefined;
}

/** The old wallet-selector kept its own keys in localStorage for good; nothing reads them now, so remove them. */
export function forgetLegacySelectorKeys(ls: Storage = localStorage): void {
  try {
    for (const k of Object.keys(ls)) if (k.startsWith("near-wallet-selector:")) ls.removeItem(k);
  } catch {
    /* storage is blocked: nothing was kept either */
  }
}

/** The kit over a connector. Separate from loadKit so tests can pass a fake connector. */
export function makeKit(connector: Pick<NearConnector, "whenManifestLoaded" | "availableWallets" | "wallets" | "manifest" | "registerWallet" | "selectWallet" | "connect" | "getConnectedWallet" | "disconnect" | "on" | "off">, ls: Pick<Storage, "removeItem"> = localStorage): Kit {
  const pinned = async (): Promise<Set<string>> => {
    await connector.whenManifestLoaded.catch(() => undefined);
    return new Set(connector.manifest.wallets.map((w) => w.id));
  };
  /**
   * A wallet that talks to `window.parent` instead of running in its own sandbox. That is how a wallet embedding a dapp
   * would reach it; for this top-level page it only ever listens to window messages, and the library registers one (and
   * lets it replace a pinned wallet of the same id) when any window posts it a `near-wallet-injected` message, with no
   * origin check. A popup we opened could do that and then answer the wallet's requests itself: it cannot forge the
   * owner's signature, but it could report a transaction as sent that never was.
   */
  const isParentFrame = (w: unknown): boolean => typeof w === "object" && w !== null && "callParentFrame" in w;
  /** Drop any such wallet and put back the pinned wallet it replaced. Runs before every operation. */
  const clean = async (): Promise<void> => {
    await connector.whenManifestLoaded.catch(() => undefined);
    if (!connector.wallets.some(isParentFrame)) return;
    connector.wallets = connector.wallets.filter((w) => !isParentFrame(w));
    for (const m of connector.manifest.wallets) await connector.registerWallet(m); // skips those still present
  };
  const trusted = <T,>(w: T): T => {
    if (isParentFrame(w)) throw new Error("That wallet connection did not come from Norr's wallet list, so it was refused. Reload the page and sign in again.");
    return w;
  };
  const known = async (id: string): Promise<void> => {
    await clean();
    if (!(await pinned()).has(id)) throw new Error("That wallet is not one Norr offers. Choose one from the list.");
  };
  return {
    async offered() {
      await clean();
      const ids = await pinned();
      return connector.availableWallets
        .filter((w) => ids.has(w.manifest.id) && w.manifest.features?.signMessage)
        .map((w) => ({ id: w.manifest.id, name: w.manifest.name, signsInOneStep: w.manifest.features?.signInAndSignMessage === true }));
    },
    async select() {
      await clean();
      const id = await connector.selectWallet({});
      await known(id);
      return id;
    },
    async signIn(id) {
      await known(id);
      const wallet = trusted(await connector.connect({ walletId: id }));
      return { wallet: wrap(wallet), accounts: await wallet.getAccounts() };
    },
    async signInAndSign(id, a) {
      await known(id);
      let got: { signedMessage?: SignedMessage }[] | undefined;
      const onSigned = (p: { accounts: { signedMessage?: SignedMessage }[] }) => {
        got = p.accounts;
      };
      connector.on("wallet:signInAndSignMessage", onSigned as never);
      try {
        const wallet = trusted(await connector.connect({ walletId: id, signMessageParams: a }));
        const signed = got?.[0]?.signedMessage;
        if (!signed) throw new Error("The wallet signed in but returned no signed message.");
        return { wallet: wrap(wallet), signed };
      } finally {
        connector.off("wallet:signInAndSignMessage", onSigned as never);
      }
    },
    async connected() {
      await clean();
      const { wallet, accounts } = await connector.getConnectedWallet();
      return { wallet: wrap(trusted(wallet)), accounts };
    },
    async disconnect() {
      try {
        await connector.disconnect();
      } catch {
        /* already signed out, or the wallet is gone: either way nothing stays remembered */
      }
      try {
        ls.removeItem(SELECTED_KEY);
      } catch {
        /* storage is blocked */
      }
    },
  };
}

/** The connector's options. `manifest` is the pinned manifest's URL (or, in tests, the manifest itself). */
export function connectorOptions(manifest: string | { wallets: unknown[]; version: string } = MANIFEST_URL, ls?: Pick<Storage, "getItem" | "setItem" | "removeItem">, doc?: Document) {
  return {
    network: "mainnet" as const,
    manifest: manifest as never,
    features: { signMessage: true },
    autoConnect: false,
    footerBranding: null,
    cspNonce: readCspNonce(doc),
    storage: guardedStorage(ls),
  };
}

/** Turn off what a dashboard that signs approvals must not offer: registering a wallet from a pasted manifest. */
export function lockDown<C extends { registerDebugWallet: unknown }>(connector: C): C {
  connector.registerDebugWallet = async () => {
    throw new Error(CUSTOM_WALLETS_OFF);
  };
  return connector;
}

let loading: Promise<Kit> | null = null;

/** The one NEAR Connect connector for this page (a second one would register every wallet's frame twice). */
export function loadKit(): Promise<Kit> {
  loading ??= (async () => {
    forgetLegacySelectorKeys();
    const { NearConnector } = await import("@hot-labs/near-connect");
    return makeKit(lockDown(new NearConnector(connectorOptions())));
  })().catch((e) => {
    loading = null; // a failed load (offline) can be tried again
    throw e;
  });
  return loading;
}

/** Whether the library remembers a connected wallet. Cheap: does not load the library. */
export function hasRememberedWallet(ls: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return Boolean(ls.getItem(SELECTED_KEY));
  } catch {
    return false;
  }
}
