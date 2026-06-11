/**
 * The `wf.rag.*` node-constructor surface for retrieval ops.
 *
 * Retrieval ops used to be free `(value, opts, ctx)` functions, so every call
 * site had to re-wrap them in `wf.op`, declare the input twice, name the thing
 * twice, and courier `ctx` by hand (Finding A, RAG tail). These constructors
 * take input *nodes* and return an output *node* — exactly like `wf.ai.*` and
 * `wf.map`/`wf.filter` — with the engine supplying `ctx` internally and a single
 * `name`.
 *
 * Layering mirrors `src/ai/graph.ts`: this module depends on `Workflow` (core),
 * never the reverse. It installs the `rag` accessor by augmenting
 * `Workflow.prototype`, so core `workflow.ts` never imports the RAG surface. The
 * accessor is live as soon as the `rag` package is imported (which any
 * retrieval op already requires).
 */

import { Workflow } from "../workflow";
import type { Node } from "../types";
import {
  retrieve,
  retrieveWithFilters,
  validateCitations,
  type RetrieveOptions,
  type RetrieveWithFiltersOptions,
  type RetrieveResult,
  type CitationResult,
} from "./retrieve";

/**
 * Node-level wiring shared by every `wf.rag.*` constructor, forwarded to the
 * underlying `wf.op`. Retrieval ops don't take an AI client (they resolve a
 * Retriever from the registry), so there is no per-op `ai` option here.
 */
export interface RAGNodeOptions {
  /** Node name (also the reasoning-record label). */
  name?: string;
  /** What to do when the op throws. Default `"stop"`. */
  onError?: "stop" | "continue";
}

/** Options for {@link RAGNamespace.retrieve}: node wiring + retrieval config. */
export interface RAGRetrieveNodeOptions extends RAGNodeOptions, RetrieveOptions {}

/** Options for {@link RAGNamespace.retrieveWithFilters}: adds static filters. */
export interface RAGRetrieveWithFiltersNodeOptions
  extends RAGNodeOptions,
    RetrieveWithFiltersOptions {}

/**
 * The object returned by `wf.rag`. Each method registers an op on the bound
 * workflow and returns its output node.
 */
export class RAGNamespace {
  constructor(private readonly wf: Workflow) {}

  /** Node-level wiring shared by every constructor. */
  private wiring(opts: RAGNodeOptions | undefined, fallbackName: string) {
    return { name: opts?.name ?? fallbackName, onError: opts?.onError };
  }

  /**
   * Pulls the top-k documents most relevant to `query` from a registered
   * Retriever (RAG fan-in). SECURITY: `query` is UNTRUSTED — see {@link retrieve}.
   */
  retrieve(
    input: Node<string>,
    opts?: RAGRetrieveNodeOptions,
  ): Node<RetrieveResult> {
    return this.wf.op(
      { input },
      ({ input }, ctx) => retrieve(input, opts ?? {}, ctx),
      this.wiring(opts, "retrieve"),
    );
  }

  /**
   * Like {@link retrieve} but with filters that scope the retrieval. The
   * `filters` node carries runtime filter values from upstream ops; omit it for
   * static-only filtering (`opts.staticFilters`). When supplied, the filters
   * node is a real dependency — a skipped filters node skips retrieval.
   * SECURITY: both `query` and filter values are UNTRUSTED — see
   * {@link retrieveWithFilters}.
   */
  retrieveWithFilters(
    input: Node<string>,
    filters?: Node<Record<string, string> | null | undefined>,
    opts?: RAGRetrieveWithFiltersNodeOptions,
  ): Node<RetrieveResult> {
    const wiring = this.wiring(opts, "retrieveWithFilters");
    if (filters) {
      return this.wf.op(
        { input, filters },
        ({ input, filters }, ctx) =>
          retrieveWithFilters(input, filters, opts ?? {}, ctx),
        wiring,
      );
    }
    return this.wf.op(
      { input },
      ({ input }, ctx) => retrieveWithFilters(input, undefined, opts ?? {}, ctx),
      wiring,
    );
  }

  /**
   * Filters LLM-emitted citations against an allow-list of source identifiers —
   * a security control. Pure (no `ctx`); see {@link validateCitations} for the
   * exact-match semantics and SECURITY notes on which output may flow downstream.
   */
  validateCitations(
    raw: Node<readonly string[] | null | undefined>,
    allowed: Node<readonly string[] | null | undefined>,
    opts?: RAGNodeOptions,
  ): Node<CitationResult> {
    return this.wf.op(
      { raw, allowed },
      ({ raw, allowed }) => validateCitations(raw, allowed),
      this.wiring(opts, "validateCitations"),
    );
  }
}

const namespaces = new WeakMap<Workflow, RAGNamespace>();

declare module "../workflow" {
  interface Workflow {
    /**
     * Node-constructor surface for retrieval ops (`wf.rag.retrieve(node, opts)`,
     * …). Installed by importing the `rag` package; see {@link RAGNamespace}.
     */
    readonly rag: RAGNamespace;
  }
}

// One namespace per workflow instance, created lazily and memoized so repeated
// `wf.rag` reads return the same object.
Object.defineProperty(Workflow.prototype, "rag", {
  configurable: true,
  get(this: Workflow): RAGNamespace {
    let ns = namespaces.get(this);
    if (!ns) {
      ns = new RAGNamespace(this);
      namespaces.set(this, ns);
    }
    return ns;
  },
});
