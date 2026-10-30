export interface StoredSession { token: string; accountId: string; expiresAt: number }
const KEY = "norr.session";

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
  } catch {
    /* nothing to clear */
  }
}
