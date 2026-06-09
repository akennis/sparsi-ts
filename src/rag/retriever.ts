/**
 * Retriever contract + registry, ported from sparsi-go library/retriever.go.
 *
 * Go threads request-scoped filters and embedding credentials through
 * context.WithValue and exposes them to Retrievers via FromContext helpers. TS
 * has no ambient context, so {@link Retriever.retrieve} receives a typed
 * {@link RetrievalContext} carrying the cancellation signal, the filters, the
 * installed embedding credentials, and a bound {@link EmbeddingClient} resolver.
 *
 * SECURITY: both the query and any filter values are UNTRUSTED — they routinely
 * originate from upstream AI ops fed by LLM output. Retriever implementations
 * MUST pass these to their backend through its parameterized-query / placeholder
 * / typed-filter API. They MUST NOT be string-concatenated into SQL, NoSQL query
 * documents, search-engine query DSLs, regex patterns, shell commands, or any
 * other interpreted context.
 */

import type { EmbeddingClient, EmbeddingCredentials } from "./embedding";

/**
 * A single retrieved item. `id` identifies it within the corpus (filename,
 * primary key, vector-store id — implementations choose). `score` conventionally
 * orders results best-first. `metadata` carries Retriever-specific extras the
 * downstream graph may want (citation URL, highlighted snippets, timestamps, ACL
 * flags, …); the framework never reads it and passes it through unchanged. Leave
 * it undefined when there is nothing extra to carry.
 */
export interface Document {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * Framework-documented {@link Document.metadata} keys. User retrievers may use
 * additional keys; these are the names the bundled examples rely on. Prefer
 * these constants over bare string literals at call sites.
 */
/** Human-readable source identifier (filename, document title). */
export const MetadataSource = "source";
/** Canonical URL for the document — convention for clickable citations. */
export const MetadataSourceURL = "source_url";
/** Matched snippets from the Retriever (typically string[]). */
export const MetadataHighlights = "highlights";
/** Last-modified timestamp for the document (canonical type: Date). */
export const MetadataUpdatedAt = "updated_at";

/**
 * Request-scoped filters made available to a {@link Retriever}. Stringly-typed
 * by convention so filters compose with the DAG's string ops. The Retriever owns
 * the interpretation of each value (parse numbers, split CSV lists, map to a
 * vector-store predicate, …); unknown keys should be ignored, not errored.
 *
 * Presence vs emptiness is meaningful: a `RetrievalContext.filters` that is
 * `undefined` means "no filters installed" (fall back to unfiltered retrieval);
 * a present instance — even an empty one — means "filters were installed".
 * {@link values} returns a fresh defensive copy each call, so a Retriever can
 * mutate the result freely without affecting this instance or any concurrent
 * Retriever's view.
 */
export class RetrievalFilters {
  private readonly map: Map<string, string>;

  constructor(entries?: Record<string, string> | Map<string, string> | null) {
    if (entries instanceof Map) {
      this.map = new Map(entries);
    } else {
      this.map = new Map(Object.entries(entries ?? {}));
    }
  }

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  /** A fresh defensive copy of the filter map, safe to mutate. */
  values(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

/**
 * The typed context a {@link Retriever} receives. Replaces Go's ctx bag: `signal`
 * carries cancellation (including any per-op embed deadline), `filters` is the
 * installed {@link RetrievalFilters} or undefined, `embeddingCredentials` is the
 * installed {@link EmbeddingCredentials} or undefined ("not installed", distinct
 * from an installed value with `factoryTimeoutMs: 0`), and
 * {@link resolveEmbeddingClient} builds an {@link EmbeddingClient} bound to the
 * installed credentials and signal.
 */
export interface RetrievalContext {
  readonly signal: AbortSignal;
  readonly filters?: RetrievalFilters;
  readonly embeddingCredentials?: EmbeddingCredentials;
  resolveEmbeddingClient(provider: string, model: string): Promise<EmbeddingClient>;
}

/**
 * Finds the `k` documents most relevant to a query. Implementations are free to
 * use any backend (BM25, embeddings + vector store, hosted search); the library
 * never sees their internals. Implementations must be safe for concurrent calls
 * — graph execution may invoke a single Retriever from multiple parallel
 * vertices.
 */
export interface Retriever {
  retrieve(query: string, k: number, ctx: RetrievalContext): Promise<Document[]>;
}

let defaultRetriever: Retriever | undefined;
const retrieverRegistry = new Map<string, Retriever>();

/**
 * Replaces the process-wide default Retriever. Call once at program start,
 * before running any graph that retrieves. Passing null clears the default.
 */
export function setDefaultRetriever(r: Retriever | null): void {
  defaultRetriever = r ?? undefined;
}

/**
 * Registers a Retriever under an id. Retrieval ops opt in via their
 * `retrieverId` option; unknown ids fall back to the process default. Passing
 * null deregisters.
 */
export function registerRetriever(id: string, r: Retriever | null): void {
  if (r === null) {
    retrieverRegistry.delete(id);
    return;
  }
  retrieverRegistry.set(id, r);
}

/**
 * Looks up an id in the registry; missing ids fall back to the process default.
 * Throws (fail-fast) when neither path yields a Retriever, so misconfigured
 * graphs fail before any retrieval runs.
 */
export function resolveRetriever(id = ""): Retriever {
  if (id !== "") {
    const r = retrieverRegistry.get(id);
    if (r) return r;
  }
  if (defaultRetriever) return defaultRetriever;
  if (id !== "") {
    throw new Error(
      `retriever "${id}" is not registered and no default Retriever is set; call registerRetriever or setDefaultRetriever before running the graph`,
    );
  }
  throw new Error(
    "no default Retriever is set; call setDefaultRetriever before running the graph",
  );
}
