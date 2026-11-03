import { describe, expect, it } from "vitest";
import { Registry, type OneClickToken } from "./registry";
import { FUNDING_CHAINS, fundingSources, unitsForUsd, validRefundAddress } from "./funding-sources";

const tok = (assetId: string, symbol: string, blockchain: string, decimals: number, price?: number, contractAddress?: string): OneClickToken => ({ assetId, symbol, blockchain, decimals, ...(price !== undefined ? { price } : {}), ...(contractAddress ? { contractAddress } : {}) });

const reg = new Registry({
  crypto: [
    tok("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "USDC", "near", 6, 1, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
    tok("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "USDC", "base", 6, 0.9993, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
    tok("nep141:eth.omft.near", "ETH", "eth", 18, 2269.31),
    tok("nep141:sol.omft.near", "SOL", "sol", 9, 92.85),
    tok("nep141:bsc-usdc", "USDC", "bsc", 18), // no price: left out
    tok("nep141:doge", "DOGE", "doge", 8, 0.1), // not offered
    tok("nep141:eth-pepe", "PEPE", "eth", 18, 0.00001, "0xpepe"), // not offered
  ],
});

describe("funding sources", () => {
  it("offers USDC on each funding chain and the main native coins, from the live list", () => {
    const s = fundingSources(reg.entries());
    expect(s.map((x) => `${x.symbol}@${x.chain}`)).toEqual(["USDC@near", "ETH@eth", "USDC@base", "SOL@sol"]);
    expect(s.find((x) => x.chain === "base")).toMatchObject({ family: "evm", evmChainId: 8453, contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 });
    expect(s.find((x) => x.symbol === "ETH")).toMatchObject({ contract: null, evmChainId: 1 });
    expect(s.find((x) => x.chain === "near")!.contract).toBeNull();
  });

  it("leaves out tokens without a price and chains Norr does not list", () => {
    const s = fundingSources(reg.entries());
    expect(s.some((x) => x.chain === "bsc" || x.symbol === "DOGE" || x.symbol === "PEPE")).toBe(false);
    expect(Object.values(FUNDING_CHAINS).filter((c) => c.family === "evm").every((c) => typeof c.evmChainId === "number")).toBe(true);
  });

  it("checks refund addresses for the source chain", () => {
    expect(validRefundAddress("evm", "0x8ba1f109551bD432803012645Ac136ddd64DBA72")).toBe(true);
    expect(validRefundAddress("evm", "0x8ba1f109551bD432803012645Ac136ddd64DBA7")).toBe(false);
    expect(validRefundAddress("evm", "alice.near")).toBe(false);
    expect(validRefundAddress("solana", "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T")).toBe(true);
    expect(validRefundAddress("solana", "0x8ba1f109551bD432803012645Ac136ddd64DBA72")).toBe(false);
    expect(validRefundAddress("near", "norrfi.near")).toBe(true);
    expect(validRefundAddress("near", "Not An Account")).toBe(false);
  });

  it("turns a USD amount into token units at the listed price, rounding down", () => {
    expect(unitsForUsd(2, 1, 6)).toBe("2000000");
    expect(unitsForUsd(2, 2269.31, 18)).toBe("881325160511344");
    expect(unitsForUsd(5, 92.85, 9)).toBe("53850296");
    expect(() => unitsForUsd(0, 1, 6)).toThrow();
  });
});
