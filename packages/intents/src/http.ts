import { IntentsApiError } from "./types";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

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
    throw new IntentsApiError(res.status, `${label}: ${msg}`);
  }
  return body;
}

export const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
