import { describe, expect, it, vi } from "vitest";
import type { FundingOffer } from "./api";
import { erc20TransferData, evmPaymentTx, explorerTx, payWithEvmWallet, qrPayload } from "./funding";

const DEP = "0x1111111111111111111111111111111111111111";
const offer = (send: Partial<NonNullable<FundingOffer["send"]>>, address = DEP): FundingOffer => ({
  id: "f", address, amountUsd: 2, amountUsdc: 2, asset: { symbol: "USDC", chain: "Base", contract: "x" }, expiresAt: "", refundTo: "r",
  send: { amount: "2", units: "2000000", symbol: "USDC", chain: "base", chainName: "Base", family: "evm", evmChainId: 8453, contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, ...send },
});

describe("paying a funding offer from the owner's wallet", () => {
  it("encodes an ERC-20 transfer to the deposit address for the exact amount", () => {
    expect(erc20TransferData(DEP, "2000000")).toBe(`0xa9059cbb${"0".repeat(24)}${"1".repeat(40)}${"0".repeat(58)}1e8480`);
    expect(() => erc20TransferData("alice.near", "1")).toThrow();
  });

  it("sends USDC by calling the token contract, and ETH directly to the deposit address", () => {
    expect(evmPaymentTx(offer({}), "0xme")).toEqual({ from: "0xme", to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", value: "0x0", data: erc20TransferData(DEP, "2000000") });
    expect(evmPaymentTx(offer({ symbol: "ETH", contract: null, units: "10000000000000000", evmChainId: 1, chain: "eth" }), "0xme")).toEqual({ from: "0xme", to: DEP, value: "0x2386f26fc10000" });
    expect(() => evmPaymentTx(offer({ family: "solana" }), "x")).toThrow();
  });

  it("switches the wallet to the offer's network before sending, and returns the hash", async () => {
    const calls: string[] = [];
    const w = { request: vi.fn(async ({ method }: { method: string }) => (calls.push(method), method === "eth_requestAccounts" ? ["0xme"] : method === "eth_sendTransaction" ? "0xhash" : null)) };
    expect(await payWithEvmWallet(w, offer({}))).toBe("0xhash");
    expect(calls).toEqual(["eth_requestAccounts", "wallet_switchEthereumChain", "eth_sendTransaction"]);
    expect(w.request.mock.calls[1]![0]).toEqual({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
  });

  it("puts a Solana Pay link in the QR for Solana, and the bare address elsewhere", () => {
    const sol = offer({ family: "solana", chain: "sol", amount: "2", contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
    expect(qrPayload(sol)).toBe("solana:4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T?amount=2&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&label=Norr");
    expect(qrPayload(offer({}))).toBe(DEP);
  });

  it("links a transaction to the right explorer, and nothing for an unknown chain or hash", () => {
    expect(explorerTx("base", `0x${"a".repeat(64)}`)).toBe(`https://basescan.org/tx/0x${"a".repeat(64)}`);
    expect(explorerTx("near", `0x${"a".repeat(64)}`)).toBeNull();
    expect(explorerTx("base", "nope")).toBeNull();
  });
});
