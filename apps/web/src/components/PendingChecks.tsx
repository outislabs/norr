import { useState } from "react";
import type { PendingItem } from "../lib/api";
import { amount, shortId } from "../lib/format";

/** What Norr asked the custody provider for, so you can compare it with the approval screen before you sign. */
export function PendingChecks({ items }: { items: PendingItem[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (items.length === 0) {
    return (
      <div>
        <p className="text-mist">Nothing is waiting for your approval.</p>
        <p className="mt-2 text-sm text-mist">When the agent places a swap, your custody provider holds it until you approve. It shows up here the moment Norr sends it, so you can check it before you sign.</p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-8">
      {items.map((p) => (
        <li key={p.requestId} className="border-l-2 border-brass pl-4">
          <p className="text-ivory">
            Norr asked to send <b className="mono font-medium">{amount(p.sends.amount)} {p.sends.symbol}</b> and receive at least{" "}
            <b className="mono font-medium">{amount(p.receivesAtLeast.amount)} {p.receivesAtLeast.symbol}</b>
            {p.venue === "confidential" ? ", confidentially" : ", publicly"}.
          </p>
          <p className="mt-1 text-sm text-mist">Paid to the vault's own account ({shortId(p.recipient, 10, 6)}).</p>
          {p.requestHash && (
            <p className="mt-2 text-sm">
              <span className="text-mist">Request hash: </span>
              <span className="mono break-all text-ivory">{p.requestHash}</span>{" "}
              <button
                type="button"
                className="ml-1 underline decoration-line underline-offset-4 hover:text-ivory"
                onClick={() => {
                  void navigator.clipboard?.writeText(p.requestHash!);
                  setCopied(p.requestId);
                }}
              >
                {copied === p.requestId ? "Copied" : "Copy"}
              </button>
            </p>
          )}
          <p className="mt-2 text-sm text-mist">{p.check}</p>
          <ol className="mt-3 list-decimal pl-5 text-sm text-mist">
            <li>Open the approval screen with the button below.</li>
            <li>Find the request: same amounts, and it pays the vault's own account, not someone else's.</li>
            <li>If anything differs, reject it and pause the vault. If it matches, approve.</li>
          </ol>
          <a className="btn btn-quiet mt-3" href="https://app.outlayer.ai/wallet/approvals" target="_blank" rel="noreferrer">
            Open the approval screen
          </a>
        </li>
      ))}
    </ul>
  );
}
