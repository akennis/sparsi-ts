/**
 * Pluggable AI client factories + provider selection.
 *
 * Faithful port of sparsi-go library/ai_factory.go + the provider-selection half
 * of ai_client.go (`newAICaller`). Go returns raw provider SDK clients
 * (`*anthropic.Client` / `*genai.Client`) and wraps them in per-model callers; in
 * TS the {@link AIClient} interface already abstracts the provider call, so a
 * factory simply returns an {@link AIClient} for a given provider + credential ref.
 *
 * SECURITY: the bundled {@link EnvAIClientFactory}'s per-ref cache has NO eviction.
 * Do NOT derive `ref` from per-request / untrusted input (tenant id, user id,
 * request header, query param — anything an attacker can vary): doing so produces
 * an unbounded cache that leaks one client per distinct value and is a
 * memory-exhaustion / DoS vector. Use `ref` only for the handful of named
 * credential lookups the application itself controls (e.g. "prod", "staging",
 * "tenant-acme"), defined at deploy time, never from request data. The library
 * never sees the API key; `ref` is a lookup reference, never the secret itself.
 */

import type { AIClient } from "../types";
import {
  AnthropicClient,
  GeminiClient,
  withRetry,
  type RetryConfig,
} from "./client";

export type AIProvider = "claude" | "gemini";

/**
 * Constructs provider clients. Implementations decide where credentials come
 * from (env vars, Vault, Secrets Manager, workload identity, an egress proxy, …)
 * and how to cache the resulting clients. `ref` is opaque to the library; empty
 * means "default".
 */
export interface AIClientFactory {
  /** Returns (and may cache) an {@link AIClient} for `provider`, keyed by `ref`. */
  forProvider(provider: AIProvider, ref?: string): AIClient;
}

function unsupportedProvider(provider: string): Error {
  return new Error(`unsupported provider "${provider}": must be "claude" or "gemini"`);
}

/**
 * The bundled factory. Reads CLAUDE_API_KEY / GEMINI_API_KEY from the process
 * environment and caches the constructed client per ref. Env-var credentials
 * don't rotate, so a single entry under the empty ref is the steady state for
 * almost all callers. `ref` is ignored (the env-var path has nothing to route
 * on); a one-time warning fires per non-empty ref. See the file-level SECURITY
 * note about the unbounded per-ref cache.
 */
export class EnvAIClientFactory implements AIClientFactory {
  private readonly anthropic = new Map<string, AIClient>();
  private readonly gemini = new Map<string, AIClient>();

  forProvider(provider: AIProvider, ref = ""): AIClient {
    switch (provider) {
      case "claude":
        return this.cached(this.anthropic, ref, "CLAUDE_API_KEY", () => new AnthropicClient());
      case "gemini":
        return this.cached(this.gemini, ref, "GEMINI_API_KEY", () => new GeminiClient());
      default:
        throw unsupportedProvider(provider);
    }
  }

  private cached(
    cache: Map<string, AIClient>,
    ref: string,
    envVar: string,
    build: () => AIClient,
  ): AIClient {
    const existing = cache.get(ref);
    if (existing) return existing;
    // The cache miss guarantees this warns on first resolution of a given ref;
    // later calls for the same ref hit the cache and skip this branch. Skip the
    // empty ref — that's the documented "use env defaults" path.
    if (ref !== "") {
      console.warn(
        `EnvAIClientFactory: ref="${ref}" is ignored — bundled factory uses ${envVar} env var only. ` +
          `Register a custom factory via registerAIClientFactory for per-ref credential routing.`,
      );
    }
    const client = build();
    cache.set(ref, client);
    return client;
  }
}

let defaultFactory: AIClientFactory = new EnvAIClientFactory();
const factoryRegistry = new Map<string, AIClientFactory>();

/**
 * Replaces the process-wide default factory. Most enterprise integrations call
 * this once at program start. Passing null resets to the bundled
 * {@link EnvAIClientFactory}.
 */
export function setDefaultAIClientFactory(f: AIClientFactory | null): void {
  defaultFactory = f ?? new EnvAIClientFactory();
}

/**
 * Registers a factory under an id. Selectable via {@link NewAIClientOptions.factoryId};
 * absent or unknown ids fall back to the default factory. Passing null removes the id.
 */
export function registerAIClientFactory(id: string, f: AIClientFactory | null): void {
  if (f === null) {
    factoryRegistry.delete(id);
    return;
  }
  factoryRegistry.set(id, f);
}

/** Looks up an id in the registry; missing ids fall back to the process default. */
export function resolveAIClientFactory(id = ""): AIClientFactory {
  if (id !== "") {
    const f = factoryRegistry.get(id);
    if (f) return f;
  }
  return defaultFactory;
}

/** Wraps a client so calls without an explicit model default to `model`. */
function withModel(inner: AIClient, model: string): AIClient {
  return {
    defaultModel: model,
    call: (req, signal) => inner.call(req.model ? req : { ...req, model }, signal),
  };
}

export interface NewAIClientOptions {
  /** Provider to target. Default "claude". */
  provider?: AIProvider;
  /** Overrides the provider client's default model. */
  model?: string;
  /** Opaque credential reference passed to the factory. Default "". */
  ref?: string;
  /** Registry key selecting a factory; "" → process default. */
  factoryId?: string;
  /** Explicit factory (dependency injection); takes precedence over factoryId/default. */
  factory?: AIClientFactory;
  /** Exponential-backoff config for transient API errors. maxRetries defaults to 3. */
  retry?: RetryConfig;
}

/**
 * Builds a retry-wrapped {@link AIClient} for the requested provider, resolving
 * credentials through the factory (explicit DI → registry-by-id → process
 * default). Mirrors sparsi-go's `newAICaller`: unknown providers throw, and a
 * non-positive maxRetries skips the retry wrapper.
 */
export function newAIClient(opts: NewAIClientOptions = {}): AIClient {
  const provider = opts.provider ?? "claude";
  if (provider !== "claude" && provider !== "gemini") {
    throw unsupportedProvider(provider);
  }
  const factory = opts.factory ?? resolveAIClientFactory(opts.factoryId ?? "");
  let client = factory.forProvider(provider, opts.ref ?? "");
  if (opts.model) client = withModel(client, opts.model);
  return withRetry(client, opts.retry ?? {});
}
