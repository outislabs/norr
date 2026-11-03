import { useEffect, useMemo, useState } from "react";
import type { Api, FundingOffer, FundingSource, FundingStatus } from "../lib/api";
import { connectEvm, explorerTx, injectedWallet, payWithEvmWallet, qrPayload } from "../lib/funding";
import { usd } from "../lib/format";
import { QrCode } from "./QrCode";

const left = (iso: string, now: number): string => {
  const s = Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** What older services (no source list) can fund from: USDC on NEAR only. */
const NEAR_ONLY: FundingSource = { assetId: "", symbol: "USDC", chain: "near", chainName: "NEAR", family: "near", decimals: 6, contract: null, priceUsd: 1 };

const refundLabel = (s: FundingSource): string => (s.family === "near" ? "NEAR account you send from (refunds go here)" : `Your ${s.chainName} address (refunds go here)`);
const refundPlaceholder = (s: FundingSource): string => (s.family === "near" ? "yourname.near" : s.family === "evm" ? "0x…" : "Your Solana address");

/**
 * Fund the vault from any chain: pick what you hold (USDC on NEAR, Ethereum, Base, Arbitrum, Optimism, Polygon, BNB
 * Chain or Solana, or ETH, SOL), get a one-time deposit address on that chain, send from your own wallet, and watch it
 * arrive as USDC in the vault's confidential balance. The destination is the vault, fixed by the Norr service; this
 * page only chooses where the money comes from and where a refund would go. The agent has no way to ask for any of it.
 */
export function FundingPanel({ api, vaultId, account = "", pollMs = 5000, onArrived }: { api: Api; vaultId: string; account?: string; pollMs?: number; onArrived?: () => void }) {
  const [sources, setSources] = useState<FundingSource[] | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [amount, setAmount] = useState("5");
  const [refund, setRefund] = useState<Record<string, string>>({ near: account });
  const [offer, setOffer] = useState<FundingOffer | null>(null);
  const [status, setStatus] = useState<FundingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState<"idle" | "waiting" | "sent">("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wallet = useMemo(() => injectedWallet(), []);

  useEffect(() => {
    let live = true;
    api.fundingSources?.().then(
      (r) => live && (setSources(r.sources), setSourceId(r.sources[0]?.assetId ?? "")),
      () => live && setSources([NEAR_ONLY]),
    ) ?? setSources([NEAR_ONLY]);
    return () => {
      live = false;
    };
  }, [api]);

  const source = sources?.find((s) => s.assetId === sourceId) ?? sources?.[0] ?? NEAR_ONLY;
  const state = status?.state ?? "waiting";
  const watching = offer !== null && state === "waiting";

  useEffect(() => {
    if (!watching) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      try {
        const s = await api.fundingStatus(vaultId, offer.id);
        setStatus(s);
        if (s.state === "arrived") onArrived?.();
      } catch {
        /* keep the last reading; the next poll tries again */
      }
    }, pollMs);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [watching, offer, api, vaultId, pollMs, onArrived]);

  async function request() {
    setError(null);
    setBusy(true);
    try {
      const refundTo = (refund[source.chain] ?? "").trim();
      setOffer(await api.requestFunding(vaultId, { amountUsd: Number(amount), ...(source.assetId ? { source: source.assetId } : {}), ...(refundTo ? { refundTo } : {}) }));
      setStatus(null);
      setCopied(false);
      setSending("idle");
      setTxHash(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not get a deposit address.");
    } finally {
      setBusy(false);
    }
  }

  async function useMyWallet() {
    setError(null);
    try {
      const a = await connectEvm(wallet!);
      setRefund((r) => ({ ...r, [source.chain]: a }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The wallet did not connect.");
    }
  }

  async function sendWithWallet() {
    setError(null);
    setSending("waiting");
    try {
      setTxHash(await payWithEvmWallet(wallet!, offer!));
      setSending("sent");
    } catch (e) {
      setSending("idle");
      setError(e instanceof Error ? e.message : "The wallet did not send.");
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(offer!.address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const expired = offer !== null && (state === "expired" || (state === "waiting" && Date.parse(offer.expiresAt) <= now));
  const send = offer?.send ?? { amount: String(offer?.amountUsdc ?? ""), symbol: offer?.asset.symbol ?? "USDC", chainName: offer?.asset.chain ?? "NEAR", family: "near" as const, chain: "near", contract: offer?.asset.contract ?? null, units: "", decimals: 6 };
  const link = txHash ? explorerTx(send.chain, txHash) : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display text-xl">Fund this vault</h2>
        <p className="mt-1 text-sm text-mute">
          Send from any chain you hold funds on. It arrives as USDC in the vault&apos;s confidential balance. You send from your own wallet, so Norr never touches your keys, and the destination is always this vault.
        </p>
      </div>

      {!offer || state === "arrived" || expired ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void request();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <label className="flex flex-col gap-1 text-sm text-mute">
              Pay with
              <select className="field font-sans" value={source.assetId} onChange={(e) => setSourceId(e.target.value)} aria-label="Pay with" disabled={!sources}>
                {(sources ?? [NEAR_ONLY]).map((s) => (
                  <option key={s.assetId || "near"} value={s.assetId}>
                    {s.symbol} on {s.chainName}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-mute">
              Amount in USD
              <input className="field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in USD" />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm text-mute">
            {refundLabel(source)}
            <div className="flex gap-2">
              <input
                className="field"
                value={refund[source.chain] ?? ""}
                onChange={(e) => setRefund((r) => ({ ...r, [source.chain]: e.target.value }))}
                aria-label={refundLabel(source)}
                placeholder={refundPlaceholder(source)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              {source.family === "evm" && wallet && (
                <button type="button" className="btn btn-quiet shrink-0 px-4 text-sm" onClick={() => void useMyWallet()}>
                  Use my wallet
                </button>
              )}
            </div>
          </label>
          <p className="text-xs text-dim">1 to 1,000 USD. {source.symbol === "USDC" ? "USDC arrives one to one, minus a fraction of a cent." : `${source.symbol} is converted to USDC on the way at the market rate.`}</p>
          <div>
            <button type="submit" className="btn btn-solid" disabled={busy || !sources}>
              {busy ? "Asking…" : offer ? "Get a new address" : "Get a deposit address"}
            </button>
          </div>
        </form>
      ) : null}

      {error && <p role="alert" className="border-l border-line-strong pl-4 text-sm text-fg">{error}</p>}

      {offer && (
        <div className="flex flex-col gap-5 border-t border-line pt-6">
          {state === "arrived" ? (
            <p className="text-fg" role="status">
              Arrived: {usd(status!.receivedUsdc)} USDC is in the vault&apos;s confidential balance (now {usd(status!.balanceUsdc)}). The balance is the custody provider&apos;s report.
              {status!.independentlyConfirmed ? " 1Click, which issued the address, independently confirms the delivery." : ""}
            </p>
          ) : (
            <>
              <p className={expired ? "text-fg" : "text-mute"} role="status">
                {expired
                  ? "This request has expired. If you already sent the money it will still arrive; otherwise get a new address."
                  : sending === "sent"
                    ? "Sent. Waiting for it to arrive, usually under a minute."
                    : `Waiting for your transfer. Send within ${left(offer.expiresAt, now)}.`}
              </p>
              <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                <QrCode value={qrPayload(offer)} label={send.family === "solana" ? "QR code with the deposit address and amount (Solana Pay)" : "QR code with the deposit address"} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-mute">
                    Send exactly <span className="text-fg">{send.amount} {send.symbol}</span> on <span className="text-fg">{send.chainName}</span> to
                  </p>
                  <p className="mono mt-2 break-all rounded-xl border border-line bg-raised p-3 text-[14px] text-fg" data-testid="deposit-address">{offer.address}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {send.family === "evm" && wallet && send.evmChainId && (
                      <button type="button" className="btn btn-solid" disabled={sending !== "idle"} onClick={() => void sendWithWallet()}>
                        {sending === "waiting" ? "Confirm in your wallet…" : sending === "sent" ? "Sent" : "Send with my wallet"}
                      </button>
                    )}
                    <button type="button" className="btn btn-quiet" onClick={() => void copy()}>
                      {copied ? "Copied" : "Copy address"}
                    </button>
                  </div>
                  {txHash && (
                    <p className="mono mt-2 break-all text-xs text-mute">
                      {link ? <a href={link} target="_blank" rel="noopener noreferrer" className="text-fg underline decoration-line-strong underline-offset-4">{txHash}</a> : txHash}
                    </p>
                  )}
                </div>
              </div>
              <ul className="flex flex-col gap-2 text-sm text-mute">
                <li className="break-words">
                  Only {send.symbol} on {send.chainName}
                  {send.contract ? <> (token <span className="mono break-all text-xs">{send.contract}</span>)</> : null}. Any other asset or network sent here is lost.
                </li>
                {offer.minArrivingUsdc !== undefined && <li>At least {usd(offer.minArrivingUsdc)} USDC arrives; a refund, if the route cannot complete, goes to <span className="mono break-all text-xs">{offer.refundTo}</span>.</li>}
                <li>Compare the address with your wallet character by character before you confirm. It is for this request only.</li>
                <li>Your transfer is a normal public transaction on {send.chainName}: your address, this address and the amount are visible there. Once it lands, the vault&apos;s balance is confidential.</li>
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
