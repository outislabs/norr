import { IntentsApiError, type UpstreamErrorDetail } from "./types";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The machine-readable parts of an error answer (code, retry seconds, limit), never the headers themselves. */
function errorDetail(body: unknown, headers: Headers | undefined): UpstreamErrorDetail {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const header = Number(headers?.get?.("retry-after"));
  const seconds = typeof b.retry_after_seconds === "number" ? b.retry_after_seconds : Number.isFinite(header) && headers?.get?.("retry-after") ? header : undefined;
  return {
    ...(typeof b.error === "string" ? { code: b.error } : {}),
    ...(seconds !== undefined && seconds >= 0 ? { retryAfterSeconds: Math.round(seconds) } : {}),
    ...(typeof b.limit === "number" ? { limit: b.limit } : {}),
    ...(typeof b.window === "string" ? { window: b.window } : {}),
  };
}

/** JSON request. Error messages carry the server's message but never headers, so keys cannot leak. */
export async function requestJson(f: FetchLike, url: string, init: RequestInit, label: string): Promise<unknown> {
  const res = await f(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the raw text */
  }
  if (!res.ok) {
    const msg =
      typeof body === "object" && body !== null && "message" in body ? String((body as { message: unknown }).message) : text.slice(0, 200);
    throw new IntentsApiError(res.status, `${label}: ${msg}`, errorDetail(body, res.headers));
  }
  return body;
}

export const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
