export interface StoredSession { token: string; accountId: string; expiresAt: number }
const KEY = "norr.session";
const UNLOCK_KEY = "norr.unlock";

/** The key that opens the private reasoning, kept for this tab only so a reload does not ask the wallet again. */
export function loadUnlock(account: string): string | null {
  try {
    const raw = sessionStorage.getItem(UNLOCK_KEY);
    const v = raw ? (JSON.parse(raw) as { account: string; secret: string }) : null;
    return v && v.account === account ? v.secret : null;
  } catch {
    return null;
  }
}
export function saveUnlock(account: string, secret: string): void {
  try {
    sessionStorage.setItem(UNLOCK_KEY, JSON.stringify({ account, secret }));
  } catch {
    /* it just will not survive a reload */
  }
}
export function clearUnlock(): void {
  try {
    sessionStorage.removeItem(UNLOCK_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Session lives in sessionStorage: gone when the tab closes. Storage can be blocked, so every access is guarded. */
export function loadSession(now = Date.now()): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    if (!s.token || s.expiresAt < now) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}
export function saveSession(s: StoredSession): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* the app still works for this tab; the session just will not survive a reload */
  }
}
export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(UNLOCK_KEY);
  } catch {
    /* nothing to clear */
  }
}
