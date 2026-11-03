import type { FundingOffer } from "./api";

/**
 * Helpers for paying a funding offer from the owner's own wallet. Norr never signs anything here: the browser wallet
 * shows the transaction and the owner confirms it. Everything is derived from the offer the service returned (the
 * one-time deposit address and the exact amount), so nothing typed on this page can change where the money goes.
 */

const pad32 = (hex: string): string => hex.replace(/^0x/i, "").toLowerCase().padStart(64, "0");

/** ERC-20 `transfer(to, amount)` call data. */
export function erc20TransferData(to: string, units: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("not an EVM address");
  return `0xa9059cbb${pad32(to)}${pad32(BigInt(units).toString(16))}`;
}

export interface EvmTx {
  from: string;
  to: string;
  value: string;
  data?: string;
}

/** The transaction that pays an EVM offer: a native transfer to the deposit address, or a token transfer to it. */
export function evmPaymentTx(offer: FundingOffer, from: string): EvmTx {
  const s = offer.send;
  if (!s || s.family !== "evm") throw new Error("This offer is not paid on an EVM chain.");
  if (s.contract) return { from, to: s.contract, value: "0x0", data: erc20TransferData(offer.address, s.units) };
  if (!/^0x[0-9a-fA-F]{40}$/.test(offer.address)) throw new Error("not an EVM address");
  return { from, to: offer.address, value: `0x${BigInt(s.units).toString(16)}` };
}

export const hexChainId = (id: number): string => `0x${id.toString(16)}`;

/**
 * What the QR code holds. Solana: a Solana Pay link with the amount (and token mint for USDC), which Phantom and
 * Solflare fill in when scanned. Other chains: the bare address, which every wallet reads; the amount is shown in text.
 */
export function qrPayload(offer: FundingOffer): string {
  const s = offer.send;
  if (s?.family === "solana") return `solana:${offer.address}?amount=${s.amount}${s.contract ? `&spl-token=${s.contract}` : ""}&label=Norr`;
  return offer.address;
}

const EXPLORERS: Record<string, string> = {
  eth: "https://etherscan.io/tx/",
  base: "https://basescan.org/tx/",
  arb: "https://arbiscan.io/tx/",
  op: "https://optimistic.etherscan.io/tx/",
  pol: "https://polygonscan.com/tx/",
  bsc: "https://bscscan.com/tx/",
};
export const explorerTx = (chain: string, hash: string): string | null => (EXPLORERS[chain] && /^0x[0-9a-fA-F]{64}$/.test(hash) ? EXPLORERS[chain] + hash : null);

/** The injected EIP-1193 wallet (MetaMask, Rabby, Phantom's EVM side, a wallet's in-app browser), if any. */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}
export const injectedWallet = (): Eip1193 | null => ((globalThis as { ethereum?: Eip1193 }).ethereum ?? null);

/** Ask the wallet for an account. */
export async function connectEvm(w: Eip1193): Promise<string> {
  const accounts = (await w.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.[0]) throw new Error("The wallet did not share an account.");
  return accounts[0];
}

/** Switch to the offer's network, then ask the wallet to send. Returns the transaction hash. */
export async function payWithEvmWallet(w: Eip1193, offer: FundingOffer): Promise<string> {
  const s = offer.send!;
  const from = await connectEvm(w);
  await w.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChainId(s.evmChainId!) }] });
  return (await w.request({ method: "eth_sendTransaction", params: [evmPaymentTx(offer, from)] })) as string;
}
