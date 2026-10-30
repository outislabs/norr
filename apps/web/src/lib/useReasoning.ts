import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, ActivityItem } from "./api";
import { deriveOwnerKey, keyFromSecret, openBox, type OwnerKey } from "./seal";
import { clearUnlock, loadUnlock, saveUnlock } from "./session";
import { signUnlock } from "./signin";

export type ReasoningState = "locked" | "unlocking" | "open" | "error";

/**
 * The owner's private view of the agent's reasoning. The service only holds it sealed to a key derived from a
 * wallet signature in this browser; unlocking asks the wallet for that one signature (no transaction), enrolls
 * the public half the first time, and opens each box here.
 */
export function useReasoning(api: Api, account: string, vaultId: string, items: ActivityItem[], reloadActivity: () => void) {
  const [state, setState] = useState<ReasoningState>("locked");
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<OwnerKey | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const tried = useRef(false);

  const finish = useCallback(async (k: OwnerKey): Promise<boolean> => {
    const enrolled = (await api.sealKey()).publicKey;
    if (enrolled === null) {
      await api.enrollSealKey(k.publicKey);
      reloadActivity();
    } else if (enrolled !== k.publicKey) {
      setError("This wallet produced a different unlock key than the one this vault's reasoning was sealed to, so those entries cannot be opened from here. You can start a new key: entries from now on will open, older ones stay sealed.");
      setState("error");
      return false;
    }
    saveUnlock(account, k.secret);
    setKey(k);
    setState("open");
    return true;
  }, [api, account, reloadActivity]);

  const unlock = useCallback(async () => {
    setError(null);
    setState("unlocking");
    try {
      await finish(await deriveOwnerKey(await signUnlock(), account));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not unlock.");
      setState("error");
    }
  }, [account, finish]);

  /** After a mismatch the owner may choose to start over with the key this wallet gives. */
  const replaceKey = useCallback(async () => {
    setError(null);
    setState("unlocking");
    try {
      const k = await deriveOwnerKey(await signUnlock(), account);
      await api.enrollSealKey(k.publicKey);
      saveUnlock(account, k.secret);
      setKey(k);
      setState("open");
      reloadActivity();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not unlock.");
      setState("error");
    }
  }, [api, account, reloadActivity]);

  const lock = useCallback(() => {
    clearUnlock();
    setKey(null);
    setTexts({});
    setState("locked");
  }, []);

  // A reload within the tab picks the key back up without asking the wallet again.
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    const secret = loadUnlock(account);
    if (!secret) return;
    keyFromSecret(secret).then(finish).catch(() => clearUnlock());
  }, [account, finish]);

  // Open every box this key can open.
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    (async () => {
      const out: Record<string, string> = {};
      for (const it of items) {
        if (it.sealedReason?.k !== "owner") continue;
        try {
          out[it.id] = await openBox(it.sealedReason, key, vaultId);
        } catch {
          /* sealed to another key: stays sealed */
        }
      }
      if (!cancelled) setTexts(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [key, items, vaultId]);

  return { state, error, texts, unlock, replaceKey, lock };
}
