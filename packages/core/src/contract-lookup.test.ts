import { describe, expect, it } from "vitest";
import { Registry, sameAddress } from "./registry";

const t = (symbol: string, blockchain: string, contractAddress: string, coingeckoId?: string) => ({ assetId: `nep141:${blockchain}-${contractAddress.toLowerCase()}.test`, symbol, blockchain, decimals: 6, price: 1, coingeckoId, contractAddress });
const reg = new Registry({
  crypto: [
    t("USDC", "base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "usd-coin"),
    t("USDC", "near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "usd-coin"),
    t("NEARKAT", "near", "kat.token0.near", "nearkat"),
    t("NEARKAT", "sol", "6UtY9iTZMQ1", "nearkat-2"),
    t("BONK", "sol", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "bonk"),
  ],
});

describe("assets by chain and contract address", () => {
  it("finds exactly that token: EVM addresses in any case, other chains exactly", () => {
    const l = reg.lookup("base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(l).toMatchObject({ kind: "found", resolution: { byContract: true, candidates: [{ chain: "base" }] } });
    expect(reg.lookup("sol:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")).toMatchObject({ kind: "found" });
    expect(reg.lookup("sol:dezxaz8z7pnrnrjjz3wxborgixca6xjnb7yab1ppb263").kind).toBe("not_routable"); // Solana is case-sensitive
    expect(sameAddress("0xABCDEF0000000000000000000000000000000001", "0xabcdef0000000000000000000000000000000001")).toBe(true);
  });

  it("a well-formed contract the catalog does not route is reported as not routable, not as unknown", () => {
    expect(reg.lookup("base:0x0000000000000000000000000000000000000bad")).toEqual({ kind: "not_routable", ref: { chain: "base", address: "0x0000000000000000000000000000000000000bad" } });
    expect(reg.lookup("mars:0x01").kind).toBe("unknown"); // a chain NEAR Intents does not have
    expect(reg.lookup("nep141:near-kat.token0.near.test").kind).toBe("found"); // an asset id is not a contract ref
  });

  it("look-alikes: a symbol shared by different tokens is ambiguous; one token on several chains is not", () => {
    expect(reg.resolve("NEARKAT")).toMatchObject({ ambiguous: true });
    expect(reg.resolve("USDC")!.ambiguous).toBeUndefined(); // same CoinGecko id on base and near
    expect(reg.lookup("near:kat.token0.near")).toMatchObject({ kind: "found", resolution: { candidates: [{ chain: "near" }] } });
  });
});
