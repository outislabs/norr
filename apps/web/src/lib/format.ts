export const usd = (n: number, digits = 2): string => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "3 minutes ago", "2 hours ago", or the date for anything older than two days. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)} hours ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

/** "882c084a…aca0" for long account ids. */
export const shortId = (s: string, head = 8, tail = 4): string => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);

export const amount = (n: number | null, max = 6): string => (n === null ? "?" : n.toLocaleString("en-US", { maximumFractionDigits: max }));
