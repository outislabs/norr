import type { WalletModuleFactory } from "@near-wallet-selector/core";

/**
 * The NEAR wallets the sign-in picker offers. One list, read by the picker, the CSP notes and the tests, so a wallet
 * cannot be configured and silently missing.
 *
 * Every wallet here implements NEP-413 `signMessage` (message, recipient, nonce; the account, public key and signature
 * come back), which sign-in and approvals need. That was checked in each package's code (@near-wallet-selector 10.1.4),
 * not just assumed; Sender's is a pass-through to the extension's own API, so it rests on a secondary source.
 * `tested` means we signed in, and approved a custody request, with a real wallet. The picker marks the rest "(untested)".
 */
export interface WalletEntry {
  /** The wallet-selector module id. */
  id: string;
  name: string;
  /** Verified end to end with Norr on a real wallet. */
  tested: boolean;
  /** What it is, and what it needs. */
  note: string;
  /** The wallet-selector factory, loaded on demand so the sign-in page stays light. */
  load: () => Promise<WalletModuleFactory>;
}

export const WALLETS: WalletEntry[] = [
  { id: "hot-wallet", name: "HOT Wallet", tested: true, note: "Browser extension, Telegram mini app and mobile; connect widget from hot-labs.org.", load: async () => (await import("@near-wallet-selector/hot-wallet")).setupHotWallet() },
  { id: "meteor-wallet", name: "Meteor Wallet", tested: false, note: "Meteor's web wallet, in its own window. The selector has no separate Meteor extension module; 'Meteor Wallet App' is for Meteor's in-app browser and signs in at page load, so it is not offered.", load: async () => (await import("@near-wallet-selector/meteor-wallet")).setupMeteorWallet() },
  { id: "my-near-wallet", name: "MyNearWallet", tested: false, note: "Web wallet, in its own window.", load: async () => (await import("@near-wallet-selector/my-near-wallet")).setupMyNearWallet() },
  { id: "intear-wallet", name: "Intear Wallet", tested: false, note: "Popup to wallet.intear.tech; its logout bridge (logout-bridge-service.intear.tech) is the one extra origin the CSP allows.", load: async () => (await import("@near-wallet-selector/intear-wallet")).setupIntearWallet() },
  { id: "nightly", name: "Nightly", tested: false, note: "Browser extension (window.nightly); no network of its own.", load: async () => (await import("@near-wallet-selector/nightly")).setupNightly() },
  { id: "sender", name: "Sender", tested: false, note: "Browser extension (window.near); its signMessage is a pass-through, so NEP-413 support rests on a secondary source until tested.", load: async () => (await import("@near-wallet-selector/sender")).setupSender() },
  { id: "ledger", name: "Ledger", tested: false, note: "Hardware wallet over WebHID (Chrome, Edge); the device must be connected from a tap, which the sign-in step may not allow.", load: async () => (await import("@near-wallet-selector/ledger")).setupLedger() },
];

/** The factories the wallet-selector is set up with, each recording why it failed to start (the selector itself drops it silently). */
export function walletFactories(onFailure: (id: string, error: unknown) => void = () => undefined): WalletModuleFactory[] {
  return WALLETS.map((w): WalletModuleFactory => async (ctx) => {
    try {
      const module = await (await w.load())(ctx);
      if (!module || w.tested) return module;
      // Say so in the picker: an untested wallet works as far as its package goes, and we have not run it with Norr.
      return { ...module, metadata: { ...module.metadata, name: `${module.metadata.name} (untested)` } } as typeof module;
    } catch (e) {
      onFailure(w.id, e);
      throw e;
    }
  });
}

/** The configured wallets the selector did not register, with the reason when it was caught. */
export function missingWallets(registeredIds: string[], failures: Map<string, unknown>): { id: string; name: string; reason: string }[] {
  return WALLETS.filter((w) => !registeredIds.includes(w.id)).map((w) => {
    const e = failures.get(w.id);
    return { id: w.id, name: w.name, reason: e instanceof Error ? e.message.slice(0, 120) : e ? String(e).slice(0, 120) : "it did not start" };
  });
}
