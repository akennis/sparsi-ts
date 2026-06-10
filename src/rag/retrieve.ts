/**
 * Retrieval ops: retrieve, retrieveWithFilters, and validateCitations.
 *
 * Connection settings are a typed options object; filters and embedding
 * credentials are passed through a typed {@link RetrievalContext} handed to the
 * resolved {@link Retriever}. The empty-vs-absent filter distinction and the
 * explicit-zero-vs-unset factory-timeout distinction are both meaningful.
 */

import {
  resolveEmbeddingClient,
  type EmbeddingCredentials,
} from "./embedding";
import {
  RetrievalFilters,
  resolveRetriever,
  type Document,
  type RetrievalContext,
} from "./retriever";
import { withDeadline } from "./timeout";

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Common options for {@link retrieve} / {@link retrieveWithFilters}. */
export interface RetrieveOptions {
  /** Number of documents to return. Default 5; must be a positive integer. */
  k?: number;
  /** Selects a Retriever registered via registerRetriever; "" → process default. */
  retrieverId?: string;
  /**
   * Opaque credential reference installed for the Retriever's embedding lookup.
   * A LOOKUP REFERENCE (e.g. "voyage-prod"), never the secret itself.
   */
  credentialRef?: string;
  /** Selects a registered EmbeddingClientFactory; "" → process default. */
  clientFactoryId?: string;
  /**
   * Deadline (ms) for the embedding factory credential lookup. undefined → 30000
   * default; 0 → disabled (but still installs credentials on the retrieval ctx,
   * distinct from "unset"). Bounds the factory lookup only, not Retrieve.
   */
  factoryTimeoutMs?: number;
  /**
   * Wallclock deadline (ms) for the ENTIRE retrieve call. undefined / 0 → no
   * per-op deadline. Must be non-negative.
   */
  embedTimeoutMs?: number;
}

/** Options for {@link retrieveWithFilters}; adds compile-time static filters. */
export interface RetrieveWithFiltersOptions extends RetrieveOptions {
  /**
   * Filters known at graph-build time, merged into the filter map every call.
   * Runtime filters win on key collision. (A comma-separated `key=value` string
   * can be turned into this record with {@link parseStaticFilters}.)
   */
  staticFilters?: Record<string, string>;
}

/** Parallel outputs: `texts[i] === documents[i].content`. */
export interface RetrieveResult {
  documents: Document[];
  texts: string[];
}

const DEFAULT_FACTORY_TIMEOUT_MS = 30_000;

function resolveK(k: number | undefined, opName: string): number {
  if (k === undefined) return 5;
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(`${opName}: k must be positive, got ${k}`);
  }
  return k;
}

function resolveEmbedTimeout(ms: number | undefined, opName: string): number {
  if (ms === undefined) return 0;
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`${opName}: embedTimeoutMs must be non-negative, got ${ms}`);
  }
  return ms;
}

/**
 * Builds the embedding credentials to install, or undefined when the caller set
 * none. Install happens only when credentialRef, clientFactoryId, or
 * factoryTimeoutMs was explicitly provided. An explicit `factoryTimeoutMs: 0`
 * still installs (the install signals intent, distinct from "unset"); when unset
 * but another credential field is set, the 30s default applies.
 */
function buildEmbeddingCredentials(opts: RetrieveOptions): EmbeddingCredentials | undefined {
  const ref = opts.credentialRef ?? "";
  const factoryId = opts.clientFactoryId ?? "";
  const timeoutSet = opts.factoryTimeoutMs !== undefined;
  if (ref === "" && factoryId === "" && !timeoutSet) return undefined;
  return {
    ref,
    factoryId,
    factoryTimeoutMs: opts.factoryTimeoutMs ?? DEFAULT_FACTORY_TIMEOUT_MS,
  };
}

async function execute(
  opName: string,
  query: string,
  opts: RetrieveOptions,
  filters: RetrievalFilters | undefined,
  signal: AbortSignal | undefined,
): Promise<RetrieveResult> {
  const k = resolveK(opts.k, opName);
  const embedTimeoutMs = resolveEmbedTimeout(opts.embedTimeoutMs, opName);
  const retriever = resolveRetriever(opts.retrieverId ?? "");
  const creds = buildEmbeddingCredentials(opts);

  let documents: Document[];
  try {
    documents = await withDeadline(embedTimeoutMs, signal, (s) => {
      const ctx: RetrievalContext = {
        signal: s,
        filters,
        embeddingCredentials: creds,
        resolveEmbeddingClient: (provider, model) =>
          resolveEmbeddingClient(creds, provider, model, s),
      };
      return Promise.resolve(retriever.retrieve(query, k, ctx));
    });
  } catch (err) {
    throw new Error(`${opName}: retrieve: ${errMsg(err)}`, { cause: err });
  }
  return { documents, texts: documents.map((d) => d.content) };
}

/**
 * Pulls the top-k documents most relevant to `query` from a registered
 * Retriever (RAG fan-in). Returns parallel `documents` and `texts`. Resolution
 * is fail-fast: throws before any retrieval if no Retriever is registered.
 *
 * SECURITY: `query` is UNTRUSTED (often LLM-sourced). The Retriever must pass it
 * to its backend through a parameterized/typed-filter API, never by string
 * concatenation into a query language.
 */
export function retrieve(
  query: string,
  opts: RetrieveOptions = {},
  ctx: { signal?: AbortSignal } = {},
): Promise<RetrieveResult> {
  return execute("RetrieveOp", query, opts, undefined, ctx.signal);
}

/**
 * Like {@link retrieve} but with filters that scope the retrieval. Filters may
 * come from `runtimeFilters` (values produced by upstream graph ops), from
 * `opts.staticFilters` (values known at graph-build time), or both — runtime
 * wins on key collision. When the merged map is empty (no static filters and an
 * empty/absent runtime map), the op warns and retrieves without filters.
 *
 * SECURITY: both `query` and all filter values are UNTRUSTED (LLM-sourced). The
 * Retriever must pass them to its backend via parameterized/typed-filter APIs.
 */
export function retrieveWithFilters(
  query: string,
  runtimeFilters: Record<string, string> | null | undefined,
  opts: RetrieveWithFiltersOptions = {},
  ctx: { signal?: AbortSignal } = {},
): Promise<RetrieveResult> {
  // Fresh copy of the static map every call so a Retriever that retains the
  // installed map can't corrupt the stored statics for the next call.
  const merged: Record<string, string> = { ...(opts.staticFilters ?? {}) };
  // Runtime wins on collision. An empty/absent runtime map falls through to
  // static filters.
  if (runtimeFilters) {
    for (const [key, value] of Object.entries(runtimeFilters)) merged[key] = value;
  }

  let filters: RetrievalFilters | undefined;
  if (Object.keys(merged).length === 0) {
    console.warn(
      "WARNING: RetrieveWithFiltersOp has no filters (Filters wire empty/disconnected and static_filters unset); retrieving without filters. If this is intentional, use RetrieveOp instead.",
    );
  } else {
    filters = new RetrievalFilters(merged);
  }
  return execute("RetrieveWithFiltersOp", query, opts, filters, ctx.signal);
}

/**
 * Parses a comma-separated `key=value` list into a record (a convenient form for
 * static filters). Whitespace around keys, values, and separators is trimmed;
 * empty input returns `{}`. Throws on malformed entries: no `=`, empty key, or
 * duplicate key.
 */
export function parseStaticFilters(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const trimmed = raw.trim();
  if (trimmed === "") return out;
  for (const rawPair of trimmed.split(",")) {
    const pair = rawPair.trim();
    if (pair === "") continue;
    const idx = pair.indexOf("=");
    if (idx < 0) {
      throw new Error(`expected key=value pair, got "${pair}"`);
    }
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key === "") {
      throw new Error(`empty key in pair "${pair}"`);
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new Error(`duplicate key "${key}"`);
    }
    out[key] = value;
  }
  return out;
}

/** The accepted/rejected split produced by {@link validateCitations}. */
export interface CitationResult {
  accepted: string[];
  rejected: string[];
}

/**
 * Filters LLM-emitted citations against an allow-list of source identifiers — a
 * security control. Membership is an exact string match (no normalization, no
 * case-folding, no trimming). Both outputs are de-duplicated and ordered by
 * first appearance in `raw`. Nil/empty `raw` → both outputs empty. Nil/empty
 * `allowed` with non-empty `raw` → every citation rejected. Never throws.
 *
 * SECURITY: only `accepted` may flow to user-facing surfaces, audit logs, or DB
 * writes. Warn-log `rejected` — those are signal about model behavior, not a
 * graph failure. Build the allow-list from the documents the model actually saw,
 * not the full corpus.
 */
export function validateCitations(
  raw: readonly string[] | null | undefined,
  allowed: readonly string[] | null | undefined,
): CitationResult {
  // Normalize to empty arrays so `.length`/iteration consumers need no null-checks.
  if (!raw || raw.length === 0) return { accepted: [], rejected: [] };
  const allowSet = new Set(allowed ?? []);
  const accepted: string[] = [];
  const rejected: string[] = [];
  const seenAccepted = new Set<string>();
  const seenRejected = new Set<string>();
  for (const s of raw) {
    if (allowSet.has(s)) {
      if (seenAccepted.has(s)) continue;
      seenAccepted.add(s);
      accepted.push(s);
    } else {
      if (seenRejected.has(s)) continue;
      seenRejected.add(s);
      rejected.push(s);
    }
  }
  return { accepted, rejected };
}
