import { ClaspError, type JsonObject } from "@clasp/core";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** JSON Schema the reply must conform to, when the backend supports structured output. */
  schema?: JsonObject;
  signal?: AbortSignal;
}

export interface ProviderStatus {
  available: boolean;
  /** Why the provider cannot be used, in words a person can act on. */
  reason?: string;
  models: string[];
  /** The model that will be used. */
  model?: string;
}

/**
 * Anything that can turn a conversation into text. Inference always sits
 * behind this interface, so the rest of Clasp never depends on a particular
 * backend — and never needs one to run existing applications.
 */
export interface AIProvider {
  readonly id: string;
  readonly label: string;
  /** `llm`: a real language model. `scripted`: predefined replies, no model involved. */
  readonly kind: "llm" | "scripted";
  status(): Promise<ProviderStatus>;
  complete(request: CompletionRequest): Promise<string>;
}

export interface OllamaOptions {
  /** Base URL of an Ollama-compatible server. */
  baseUrl?: string;
  /** Model name; when omitted a locally installed model is chosen. */
  model?: string;
  fetch?: typeof fetch;
  /** Maximum time to wait for a completion. */
  timeoutMs?: number;
  temperature?: number;
  /** Context window to ask the model for, in tokens (Ollama's num_ctx). Default 16384. */
  contextLength?: number;
}

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/** Models tried first when the user has not chosen one, most suitable first. */
const PREFERRED = [/qwen2\.5-coder/i, /qwen3/i, /qwen/i, /gemma/i, /llama3/i, /mistral/i, /phi/i];

export function pickModel(models: readonly string[], wanted?: string): string | undefined {
  if (wanted && models.includes(wanted)) return wanted;
  for (const pattern of PREFERRED) {
    const match = models.find((model) => pattern.test(model));
    if (match) return match;
  }
  return models[0];
}

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Talks to a local Ollama-compatible server (`/api/tags`, `/api/chat`).
 * No API key, no cloud: if the server is not running, `status()` says so and
 * everything else in Clasp keeps working.
 */
export class OllamaProvider implements AIProvider {
  readonly id = "ollama";
  readonly label = "Ollama (local model)";
  readonly kind = "llm" as const;
  readonly baseUrl: string;
  model: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly contextLength: number;

  constructor(options: OllamaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
    this.model = options.model;
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.temperature = options.temperature ?? 0;
    this.contextLength = options.contextLength ?? 16_384;
  }

  async status(): Promise<ProviderStatus> {
    try {
      const response = await this.fetcher(`${this.baseUrl}/api/tags`, { signal: withTimeout(4000) });
      if (!response.ok) {
        return { available: false, reason: `Ollama at ${this.baseUrl} answered with HTTP ${response.status}.`, models: [] };
      }
      const body = (await response.json()) as { models?: Array<{ name?: string }> };
      const models = (body.models ?? []).map((entry) => entry.name).filter((name): name is string => typeof name === "string");
      if (models.length === 0) {
        return {
          available: false,
          reason: `Ollama is running at ${this.baseUrl} but has no models installed. Install one, for example: ollama pull qwen2.5-coder`,
          models,
        };
      }
      const model = pickModel(models, this.model);
      return { available: true, models, ...(model ? { model } : {}) };
    } catch {
      return {
        available: false,
        reason: `No local model server is reachable at ${this.baseUrl}. Start Ollama ("ollama serve") to use AI generation. Everything else keeps working.`,
        models: [],
      };
    }
  }

  async complete(request: CompletionRequest): Promise<string> {
    let model = this.model;
    if (!model) {
      const status = await this.status();
      if (!status.available || !status.model) {
        throw new ClaspError("UNAVAILABLE", status.reason ?? "No local model is available.");
      }
      model = status.model;
    }
    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
      stream: false,
      format: request.schema ?? "json",
      // Ollama silently drops the start of a prompt longer than its context
      // window — which is where the rules are — so ask for enough room.
      options: { temperature: this.temperature, num_ctx: this.contextLength },
      // Reasoning tokens are not needed for a structured plan and slow local models down.
      think: false,
    };
    const post = async (): Promise<Response> => {
      try {
        return await this.fetcher(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: withTimeout(this.timeoutMs, request.signal),
        });
      } catch (cause) {
        const aborted = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
        throw new ClaspError(
          "UNAVAILABLE",
          aborted
            ? `The local model did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`
            : `Could not reach the local model server at ${this.baseUrl}.`,
          { cause },
        );
      }
    };
    let response = await post();
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (/think/i.test(text)) {
        // Models without a reasoning mode reject the flag; retry without it.
        delete body.think;
        response = await post();
      }
      if (!response.ok) {
        const detail = response.bodyUsed ? text : await response.text().catch(() => "");
        throw new ClaspError("UNAVAILABLE", `The local model server answered with HTTP ${response.status}. ${detail}`.trim());
      }
    }
    const payload = (await response.json()) as { message?: { content?: unknown }; error?: unknown };
    const content = payload.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new ClaspError("UNAVAILABLE", typeof payload.error === "string" ? payload.error : "The local model returned an empty reply.");
    }
    return content;
  }
}
