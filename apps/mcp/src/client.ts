export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class EnclaveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EnclaveError";
  }
}

export interface EnclaveClientOptions {
  /** Base URL of the Norr service, for example http://localhost:8787. */
  baseUrl: string;
  /** The agent token, scoped to one vault. Sent only as a bearer header, never logged. */
  token: string;
  fetch?: FetchLike;
}

/** The only thing the MCP server knows how to do: call the Norr agent API with one vault's token. */
export class EnclaveClient {
  private readonly f: FetchLike;
  private readonly base: string;

  constructor(private readonly o: EnclaveClientOptions) {
    this.f = o.fetch ?? ((url, init) => fetch(url, init));
    this.base = o.baseUrl.replace(/\/+$/, "");
  }

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        ...init,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.o.token}`, ...(init.headers as Record<string, string> | undefined) },
      });
    } catch {
      throw new EnclaveError(0, "Could not reach the Norr service. Check that it is running and NORR_API_URL is right.");
    }
    if (res.status === 401) throw new EnclaveError(401, "The Norr agent token was rejected. It may be wrong or revoked; ask the vault owner for a new one.");
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
      throw new EnclaveError(res.status, `The Norr service refused the request: ${msg}`);
    }
    return body;
  }

  get(path: string, query: Record<string, string | undefined> = {}): Promise<unknown> {
    const q = Object.entries(query).filter(([, v]) => v !== undefined) as [string, string][];
    const qs = q.length ? `?${new URLSearchParams(q).toString()}` : "";
    return this.call(`${path}${qs}`);
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.call(path, { method: "POST", body: JSON.stringify(body) });
  }
}
