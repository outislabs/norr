import { createHash } from "node:crypto";

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/**
 * A minimal client for an OpenAI-compatible chat API with tool calling (NEAR AI Cloud by default). Written
 * against `fetch` rather than a vendor SDK, so it is small enough to read and the key only ever appears in one header.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** What a response signature covers: SHA-256 (hex) of the exact request and response bytes, and the model asked for. */
export interface Exchange {
  model: string;
  requestHash: string;
  responseHash: string;
}

export interface ChatResult {
  /** The provider's completion id, which the signature endpoint takes (`/v1/signature/{id}`). */
  id: string;
  message: ChatMessage;
  usage: Usage;
  finishReason: string;
  /** Present when the client hashed the raw bytes (the real client does; test doubles need not). */
  exchange?: Exchange;
}

export interface Chat {
  chat(req: { model: string; messages: ChatMessage[]; tools?: ToolDef[]; maxTokens?: number }): Promise<ChatResult>;
}

export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

export interface ChatClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Extra attempts after a rate limit or server error. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class ChatClient implements Chat {
  private readonly baseUrl: string;
  private readonly f: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: ChatClientOptions) {
    if (!o.apiKey) throw new Error("A NEAR AI Cloud API key is required (NEAR_AI_API_KEY).");
    this.baseUrl = (o.baseUrl ?? "https://cloud-api.near.ai/v1").replace(/\/+$/, "");
    this.f = o.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = o.timeoutMs ?? 120_000;
    this.retries = o.retries ?? 2;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async chat(req: { model: string; messages: ChatMessage[]; tools?: ToolDef[]; maxTokens?: number }): Promise<ChatResult> {
    const body = JSON.stringify({ model: req.model, messages: req.messages, ...(req.tools?.length ? { tools: req.tools, tool_choice: "auto" } : {}), max_tokens: req.maxTokens ?? 2000 });
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.f(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}`, "user-agent": "norr-agent/0.1", "x-no-aliasing": "true", "accept-encoding": "identity" },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        if (attempt < this.retries) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new ChatError(0, "Could not reach the model service.");
      }
      if (RETRYABLE.has(res.status) && attempt < this.retries) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      const raw = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
      const json = (() => {
        try {
          return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      if (!res.ok || !json) {
        const detail = typeof (json?.error as { message?: unknown } | undefined)?.message === "string" ? (json!.error as { message: string }).message : `HTTP ${res.status}`;
        throw new ChatError(res.status, `Model service error: ${detail.slice(0, 200)}`);
      }
      const choice = (json.choices as { message?: ChatMessage; finish_reason?: string }[] | undefined)?.[0];
      if (!choice?.message) throw new ChatError(502, "Model service returned no message.");
      const u = (json.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
      return {
        id: String(json.id ?? ""),
        message: { role: "assistant", content: choice.message.content ?? null, ...(choice.message.tool_calls?.length ? { tool_calls: choice.message.tool_calls } : {}) },
        usage: { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0 },
        finishReason: choice.finish_reason ?? "",
        exchange: { model: req.model, requestHash: sha256Hex(new TextEncoder().encode(body)), responseHash: sha256Hex(raw) },
      };
    }
  }
}

/** Per-million-token prices, as the service lists them. */
export interface Price {
  input: number;
  output: number;
}

/** Upper-bound cost: cached-prompt discounts are not applied. */
export const costUsd = (u: Usage, p: Price): number => (u.promptTokens * p.input + u.completionTokens * p.output) / 1_000_000;

export const addUsage = (a: Usage, b: Usage): Usage => ({ promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens });

export interface ModelInfo {
  id: string;
  owner: string;
  price: Price;
  tools: boolean;
}

/** The models the service offers, with price, owner and tool support. `owned_by: "nearai"` marks NEAR's own attested TEEs. */
export async function listModels(o: { apiKey: string; baseUrl?: string; fetch?: FetchLike }): Promise<ModelInfo[]> {
  const f = o.fetch ?? ((url, init) => fetch(url, init));
  const res = await f(`${(o.baseUrl ?? "https://cloud-api.near.ai/v1").replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${o.apiKey}`, "user-agent": "norr-agent/0.1" } });
  if (!res.ok) throw new ChatError(res.status, `Could not list models (HTTP ${res.status}).`);
  const body = (await res.json()) as { data?: { id: string; owned_by?: string; pricing?: { input?: number; output?: number }; supported_features?: string[] }[] };
  return (body.data ?? []).map((m) => ({ id: m.id, owner: m.owned_by ?? "", price: { input: m.pricing?.input ?? 0, output: m.pricing?.output ?? 0 }, tools: (m.supported_features ?? []).includes("tools") }));
}
