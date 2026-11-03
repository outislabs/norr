import { useEffect, useState } from "react";
import type { Api, FundingOffer, FundingStatus } from "../lib/api";
import { usd } from "../lib/format";

const left = (iso: string, now: number): string => {
  const s = Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Put USDC into the vault's confidential balance: ask for a one-time address, send to it from your own
 * wallet, watch for it to arrive. The address comes from the custody provider through the Norr service;
 * the agent has no way to ask for one.
 */
export function FundingPanel({ api, vaultId, account = "", pollMs = 5000, onArrived }: { api: Api; vaultId: string; account?: string; pollMs?: number; onArrived?: () => void }) {
  const [amount, setAmount] = useState("5");
  const [from, setFrom] = useState(account);
  const [offer, setOffer] = useState<FundingOffer | null>(null);
  const [status, setStatus] = useState<FundingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

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
      const n = Number(amount);
      setOffer(await api.requestFunding(vaultId, n, from.trim() || undefined));
      setStatus(null);
      setCopied(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not get a deposit address.");
    } finally {
      setBusy(false);
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

  return (
    <div className="flex max-w-xl flex-col gap-5">
      <div>
        <h2 className="font-display text-xl">Fund this vault</h2>
        <p className="mt-1 text-sm text-mute">
          USDC sent to the one-time address below settles into the vault&apos;s confidential balance. You send it from your own wallet, so Norr never touches your keys.
        </p>
      </div>

      {!offer || state === "arrived" || expired ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void request();
          }}
        >
          <label className="flex flex-col gap-1 text-sm text-mute">
            Amount in USDC (1 to 1000)
            <input className="field w-40" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in USDC" />
          </label>
          <label className="flex min-w-60 flex-col gap-1 text-sm text-mute">
            Account you will send from (refunds go here)
            <input className="field" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Account you will send from" placeholder="yourname.near" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </label>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "Asking…" : offer ? "Get a new address" : "Get a deposit address"}
          </button>
        </form>
      ) : null}

      {error && <p role="alert" className="text-alert">{error}</p>}

      {offer && (
        <div className="flex flex-col gap-4 border-t border-line pt-5">
          {state === "arrived" ? (
            <p className="text-ok" role="status">
              Arrived: {usd(status!.receivedUsdc)} USDC is in the vault&apos;s confidential balance (now {usd(status!.balanceUsdc)}). The balance is the custody provider&apos;s report.
              {status!.independentlyConfirmed ? " 1Click, which issued the address, independently confirms the delivery." : ""}
            </p>
          ) : (
            <>
              <p className={expired ? "text-alert" : "text-accent"} role="status">
                {expired ? "This request has expired. If you already sent the money it will still arrive; otherwise get a new address." : `Waiting for ${usd(offer.amountUsdc)} USDC. Send within ${left(offer.expiresAt, now)}.`}
              </p>
              <div>
                <p className="text-sm text-mute">Send exactly {offer.amountUsdc} {offer.asset.symbol} on {offer.asset.chain} to</p>
                <p className="mono mt-1 break-all rounded-sm border border-line bg-raised p-3 text-[15px] text-fg" data-testid="deposit-address">{offer.address}</p>
                <button type="button" className="btn btn-quiet mt-2" onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy address"}
                </button>
              </div>
              <ul className="list-disc pl-5 text-sm text-mute">
                <li>
                  Only {offer.asset.symbol} on {offer.asset.chain} (contract <span className="mono break-all">{offer.asset.contract}</span>). Any other asset or network sent here is lost.
                </li>
                <li>Compare the address with your wallet character by character before you confirm. It is for this request only.</li>
                <li>Your transfer is a normal public transaction: your account, this address and the amount are visible onchain. Norr never sees your keys.</li>
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
