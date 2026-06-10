import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import type { Content, GenerateContentConfig } from "@google/genai";
import type {
  AICallRequest,
  AICallResponse,
  AIClient,
  RunContext,
} from "../types";

/** Throws a descriptive error if no AI client was provided to the run. */
export function requireAI(ctx: RunContext): AIClient {
  if (!ctx.ai) {
    throw new Error(
      "no AI client configured: pass { ai } to workflow.run() (e.g. new AnthropicClient() or a MockAIClient)",
    );
  }
  return ctx.ai;
}

export interface AnthropicClientOptions {
  apiKey?: string;
  model?: string;
  /** Forwarded to the underlying SDK client (baseURL, timeout, etc.). */
  sdkOptions?: ConstructorParameters<typeof Anthropic>[0];
}

/** AIClient backed by the official Anthropic SDK. */
export class AnthropicClient implements AIClient {
  readonly defaultModel: string;
  private readonly sdk: Anthropic;

  constructor(opts: AnthropicClientOptions = {}) {
    // Only CLAUDE_API_KEY is read (the descriptions advertise CLAUDE_API_KEY
    // exclusively).
    const apiKey = opts.apiKey ?? process.env.CLAUDE_API_KEY;
    this.defaultModel = opts.model ?? "claude-sonnet-4-6";
    this.sdk = new Anthropic({ apiKey, ...opts.sdkOptions });
  }

  async call(req: AICallRequest, signal?: AbortSignal): Promise<AICallResponse> {
    const msg = await this.sdk.messages.create(
      {
        model: req.model ?? this.defaultModel,
        max_tokens: req.maxTokens ?? 1024,
        ...(req.system ? { system: req.system } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      },
      { signal },
    );
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, model: msg.model, raw: msg };
  }
}

export interface GeminiClientOptions {
  apiKey?: string;
  model?: string;
  /** Inject a pre-built SDK client (e.g. a shared, factory-cached instance). */
  sdk?: GoogleGenAI;
}

/**
 * AIClient backed by the official `@google/genai` SDK (the `provider: "gemini"`
 * path). Maps the shared {@link AICallRequest} onto GenerateContent: system →
 * systemInstruction, messages → user/model contents, maxTokens → maxOutputTokens.
 */
export class GeminiClient implements AIClient {
  readonly defaultModel: string;
  private readonly sdk: GoogleGenAI;

  constructor(opts: GeminiClientOptions = {}) {
    this.defaultModel = opts.model ?? "gemini-2.5-flash";
    if (opts.sdk) {
      this.sdk = opts.sdk;
      return;
    }
    const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
    try {
      this.sdk = new GoogleGenAI({ apiKey });
    } catch (err) {
      throw new Error(
        `gemini: create client: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async call(req: AICallRequest, signal?: AbortSignal): Promise<AICallResponse> {
    const model = req.model ?? this.defaultModel;
    const contents: Content[] = req.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const config: GenerateContentConfig = {};
    if (req.system) config.systemInstruction = req.system;
    // Gemini truncates very small token budgets, causing spurious parse failures,
    // so floor any small budget at 64.
    if (req.maxTokens !== undefined) config.maxOutputTokens = Math.max(req.maxTokens, 64);
    if (req.temperature !== undefined) config.temperature = req.temperature;
    if (signal) config.abortSignal = signal;

    let res;
    try {
      res = await this.sdk.models.generateContent({ model, contents, config });
    } catch (err) {
      throw new Error(
        `gemini: generate content: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = res.text ?? "";
    if (text === "" && (res.candidates?.length ?? 0) > 0) {
      console.warn(`gemini.empty: finish_reason=${res.candidates?.[0]?.finishReason ?? ""}`);
    }
    return { text, model, raw: res };
  }
}

/** Returns true for API errors worth retrying (rate limits, overload, 5xx). */
export function isTransientError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return [
    "503",
    "429",
    "too many requests",
    "rate limit",
    "rate_limit",
    "overloaded",
    "unavailable",
    "high demand",
    "try again",
    "service unavailable",
  ].some((p) => msg.includes(p));
}

export interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

/** Wraps a client with exponential backoff + jitter on transient errors. */
export function withRetry(inner: AIClient, cfg: RetryConfig = {}): AIClient {
  const maxRetries = cfg.maxRetries ?? 3;
  const initialDelayMs = cfg.initialDelayMs ?? 500;
  if (maxRetries <= 0) return inner;
  return {
    defaultModel: inner.defaultModel,
    async call(req, signal) {
      let delay = initialDelayMs;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          const jitter = Math.floor((Math.random() * delay) / 4);
          await sleep(delay + jitter, signal);
          delay = Math.min(delay * 2, 30_000);
        }
        try {
          return await inner.call(req, signal);
        } catch (err) {
          if (!isTransientError(err)) throw err;
          lastErr = err;
        }
      }
      throw new Error(
        `after ${maxRetries} retries: ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`,
      );
    },
  };
}

export type MockHandler = (
  req: AICallRequest,
  callIndex: number,
) => string | AICallResponse;

/** A scriptable in-memory client for tests. Records every request. */
export class MockAIClient implements AIClient {
  readonly defaultModel = "mock";
  readonly calls: AICallRequest[] = [];
  private readonly handler: MockHandler;

  constructor(handler: MockHandler | string[]) {
    if (Array.isArray(handler)) {
      const scripted = handler;
      this.handler = (_req, i) => scripted[Math.min(i, scripted.length - 1)] ?? "";
    } else {
      this.handler = handler;
    }
  }

  async call(req: AICallRequest): Promise<AICallResponse> {
    this.calls.push(req);
    const out = this.handler(req, this.calls.length - 1);
    return typeof out === "string" ? { text: out } : out;
  }
}
