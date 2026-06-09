/**
 * Embedding clients + pluggable factory, ported from sparsi-go
 * library/embedding_factory.go.
 *
 * Go returns raw provider SDK clients and threads credentials through
 * context.WithValue; in TS the {@link EmbeddingClient} interface abstracts the
 * provider call, credentials are a typed {@link EmbeddingCredentials} value, and
 * the factory-lookup deadline is modeled with {@link withDeadline}.
 *
 * SECURITY: the bundled {@link EnvEmbeddingClientFactory}'s per-ref cache has NO
 * eviction. Do NOT derive `ref` from per-request / untrusted input (tenant id,
 * user id, request header, query param): doing so produces an unbounded cache
 * that leaks one client per distinct value and is a memory-exhaustion / DoS
 * vector. Use `ref` only for the handful of named credential lookups the
 * application controls (e.g. "prod", "staging", "voyage-prod"), defined at
 * deploy time, never from request data. The library never sees the API key;
 * `ref` is a lookup reference, never the secret itself.
 */

import { GoogleGenAI } from "@google/genai";
import { withDeadline } from "./timeout";

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The framework-owned shape user Retrievers consume. Implementations call
 * whichever provider SDK they want internally; the library only sees number[][]
 * vectors. `embed` returns one vector per input text in the same order and must
 * be safe for concurrent calls from parallel graph vertices.
 */
export interface EmbeddingClient {
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/**
 * Constructs {@link EmbeddingClient}s. `ref` is opaque to the library (same
 * contract as the AI factory's ref); `provider`/`model` are passed through so a
 * single factory can serve multiple embedders. Implementations decide whether
 * to cache per (provider, model, ref) and how to handle unsupported providers.
 */
export interface EmbeddingClientFactory {
  embedder(
    provider: string,
    model: string,
    ref: string,
    signal?: AbortSignal,
  ): EmbeddingClient | Promise<EmbeddingClient>;
}

/**
 * Caps the inputs sent in a single gemini-embedding EmbedContent request.
 * Gemini's documented per-call batch limit is ~100 inputs; we use 100 as a
 * defensive bound on request size, memory, and quota exposure. Not user-tunable
 * — {@link GeminiEmbeddingClient.embed} chunks larger inputs into sequential
 * calls and concatenates results in input order.
 */
export const GEMINI_EMBEDDING_MAX_BATCH = 100;

/** The shape {@link GeminiEmbeddingClient}'s embed hook returns (a genai EmbedContentResponse subset). */
export interface EmbedOnceResponse {
  embeddings?: Array<{ values?: number[] } | null | undefined>;
}

/** Test seam: issues one upstream EmbedContent call for a chunk already within the batch cap. */
export type EmbedOnce = (texts: string[], signal?: AbortSignal) => Promise<EmbedOnceResponse>;

export interface GeminiEmbeddingClientOptions {
  model?: string;
  /** Inject a pre-built SDK client (e.g. a shared, factory-cached instance). */
  sdk?: GoogleGenAI;
  /** Test indirection; production leaves it unset and dispatches to the SDK directly. */
  embedOnce?: EmbedOnce;
}

/**
 * {@link EmbeddingClient} backed by the `@google/genai` SDK. Requests are
 * automatically chunked at {@link GEMINI_EMBEDDING_MAX_BATCH} inputs per
 * upstream call; larger slices split into sequential calls concatenated in
 * input order. If any chunk fails, the first error surfaces and earlier partial
 * results are discarded. Empty input returns `[]` without touching the API.
 */
export class GeminiEmbeddingClient implements EmbeddingClient {
  readonly model: string;
  private readonly embedOnce: EmbedOnce;

  constructor(opts: GeminiEmbeddingClientOptions = {}) {
    this.model = opts.model ?? "gemini-embedding-001";
    if (opts.embedOnce) {
      this.embedOnce = opts.embedOnce;
    } else {
      const sdk = opts.sdk;
      if (!sdk) {
        throw new Error("GeminiEmbeddingClient: an sdk or embedOnce must be provided");
      }
      this.embedOnce = async (texts, signal) => {
        const res = await sdk.models.embedContent({
          model: this.model,
          contents: texts,
          ...(signal ? { config: { abortSignal: signal } } : {}),
        });
        return { embeddings: res.embeddings };
      };
    }
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += GEMINI_EMBEDDING_MAX_BATCH) {
      const chunk = texts.slice(start, start + GEMINI_EMBEDDING_MAX_BATCH);
      const vecs = await this.embedChunk(chunk, signal);
      out.push(...vecs);
    }
    return out;
  }

  private async embedChunk(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    let resp: EmbedOnceResponse;
    try {
      resp = await this.embedOnce(texts, signal);
    } catch (err) {
      throw new Error(`gemini embedding: embed content: ${errMsg(err)}`, { cause: err });
    }
    const embeds = resp.embeddings ?? [];
    if (embeds.length !== texts.length) {
      throw new Error(
        `gemini embedding: response count mismatch: got ${embeds.length}, want ${texts.length}`,
      );
    }
    const out: number[][] = [];
    for (let i = 0; i < embeds.length; i++) {
      const e = embeds[i];
      if (e == null || e.values == null) {
        throw new Error(`gemini embedding: nil embedding at index ${i}`);
      }
      out.push(e.values);
    }
    return out;
  }
}

/**
 * The bundled default embedding factory — gemini-ONLY. This is asymmetric with
 * the bundled AI factory (which supports Claude and Gemini); any other embedding
 * provider (Claude, OpenAI, Voyage, Cohere, Vertex, …) must register a custom
 * factory via {@link registerEmbeddingClientFactory} (or
 * {@link setDefaultEmbeddingClientFactory}) before running the graph.
 *
 * Serves gemini via the `@google/genai` SDK (GEMINI_API_KEY) and rejects every
 * other provider with an error pointing at the registration entry points. The
 * factory caches one GoogleGenAI client per ref; `ref` is ignored on the env-var
 * path and a one-time warning fires per non-empty ref. See the file-level
 * SECURITY note about the unbounded per-ref cache.
 */
export class EnvEmbeddingClientFactory implements EmbeddingClientFactory {
  private readonly gemini = new Map<string, GoogleGenAI>();

  embedder(provider: string, model: string, ref = ""): EmbeddingClient {
    if (provider !== "gemini") {
      throw new Error(
        `EnvEmbeddingClientFactory: provider "${provider}" not supported; register a custom EmbeddingClientFactory via registerEmbeddingClientFactory (or setDefaultEmbeddingClientFactory)`,
      );
    }
    let client = this.gemini.get(ref);
    if (!client) {
      // The cache miss guarantees this warns on first resolution of a given
      // ref; later same-ref calls hit the cache and skip this branch. Skip the
      // empty ref — that's the documented "use env defaults" path.
      if (ref !== "") {
        console.warn(
          `EnvEmbeddingClientFactory: ref="${ref}" is ignored — bundled factory uses GEMINI_API_KEY env var only. ` +
            `Register a custom factory via registerEmbeddingClientFactory for per-ref credential routing.`,
        );
      }
      try {
        client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      } catch (err) {
        throw new Error(`gemini embedding: create client: ${errMsg(err)}`, { cause: err });
      }
      this.gemini.set(ref, client);
    }
    return new GeminiEmbeddingClient({ sdk: client, model });
  }
}

let defaultEmbeddingFactory: EmbeddingClientFactory = new EnvEmbeddingClientFactory();
const embeddingFactoryRegistry = new Map<string, EmbeddingClientFactory>();

/**
 * Replaces the process-wide default embedding factory. Most enterprise
 * integrations call this once at program start. Passing null resets to the
 * bundled {@link EnvEmbeddingClientFactory}.
 */
export function setDefaultEmbeddingClientFactory(f: EmbeddingClientFactory | null): void {
  defaultEmbeddingFactory = f ?? new EnvEmbeddingClientFactory();
}

/**
 * Registers an embedding factory under an id. Retrieval ops opt in via their
 * `clientFactoryId` option; absent or unknown ids fall back to the default.
 * Passing null deregisters.
 */
export function registerEmbeddingClientFactory(
  id: string,
  f: EmbeddingClientFactory | null,
): void {
  if (f === null) {
    embeddingFactoryRegistry.delete(id);
    return;
  }
  embeddingFactoryRegistry.set(id, f);
}

/** Looks up an id in the registry; missing ids fall back to the process default. */
export function resolveEmbeddingFactory(id = ""): EmbeddingClientFactory {
  if (id !== "") {
    const f = embeddingFactoryRegistry.get(id);
    if (f) return f;
  }
  return defaultEmbeddingFactory;
}

/**
 * The credential routing values flowing from a retrieval vertex to a user
 * Retriever. `ref` is opaque to the library; `factoryId` selects a registered
 * factory (empty → default); `factoryTimeoutMs` bounds ONLY the factory
 * credential lookup (the subsequent embed call honors the ambient signal).
 */
export interface EmbeddingCredentials {
  readonly ref: string;
  readonly factoryId: string;
  /** Bounds the factory lookup only. 0 → no deadline. */
  readonly factoryTimeoutMs: number;
}

/** The zero credentials: empty ref/factory, no factory deadline. */
export const zeroEmbeddingCredentials: EmbeddingCredentials = {
  ref: "",
  factoryId: "",
  factoryTimeoutMs: 0,
};

/**
 * Builds an {@link EmbeddingClient} from the given credentials and the requested
 * provider/model. The canonical entry point user Retrievers call to embed query
 * text — never read embedding env vars directly.
 *
 * When `creds.factoryTimeoutMs > 0`, only the factory credential lookup is
 * bounded by that deadline; the returned client's embed calls honor whatever
 * signal the caller passes them. Factory errors (including deadline) are wrapped
 * as `embedding client: <err>` with the original error preserved as `.cause`, so
 * {@link isDeadlineExceeded} still detects a fired deadline through the wrapper.
 */
export async function resolveEmbeddingClient(
  creds: EmbeddingCredentials | undefined,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<EmbeddingClient> {
  const c = creds ?? zeroEmbeddingCredentials;
  const factory = resolveEmbeddingFactory(c.factoryId);
  try {
    return await withDeadline(c.factoryTimeoutMs, signal, (s) =>
      Promise.resolve(factory.embedder(provider, model, c.ref, s)),
    );
  } catch (err) {
    // Preserve the cause chain so isDeadlineExceeded(wrapped) still detects a fired deadline.
    throw new Error(`embedding client: ${errMsg(err)}`, { cause: err });
  }
}
