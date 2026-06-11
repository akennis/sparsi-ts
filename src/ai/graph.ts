/**
 * The `wf.ai.*` node-constructor surface for AI ops.
 *
 * AI ops used to be free `(value, opts, ctx)` functions, so every call site had
 * to re-wrap them in `wf.op`, declare the single input twice, name the thing
 * twice, and courier `ctx` by hand. These constructors take input *nodes* and
 * return an output *node* — exactly like `wf.map`/`wf.filter` — with the engine
 * supplying `ctx` internally and a single `name`.
 *
 * Layering: this module depends on `Workflow` (core), never the reverse. It
 * installs the `ai` accessor by augmenting `Workflow.prototype`, so core
 * `workflow.ts` never imports the AI SDKs. The accessor is live as soon as the
 * `ai` package is imported (which any AI op already requires).
 */

import { Workflow } from "../workflow";
import type { Condition, OpDefOptions } from "../workflow";
import type { AIClient, Node, NodeMap, RunContext } from "../types";
import { withAI } from "../context";
import { withRetry, type RetryConfig } from "./client";
import { aiCompute, type AIComputeResult, type OutputKind } from "./compute";
import {
  modeSelect,
  aiBool,
  aiScore,
  aiClassifyMultiLabel,
  aiBestMatch,
  aiRerank,
  aiSummarize,
  aiExtractStringSlice,
  aiExtractMap,
  aiParseNumber,
} from "./ops";

/**
 * Options common to every `wf.ai.*` node constructor. `name`/`ai`/`onError` are
 * the node-level wiring (forwarded to the underlying `wf.op`); `maxRetries`/
 * `model` configure the AI call itself.
 */
export interface AINodeOptions {
  /** Parse/validation retries beyond the first. Default 3. */
  maxRetries?: number;
  /** Overrides the client's default model for this op. */
  model?: string;
  /** Node name (also the reasoning-record label). */
  name?: string;
  /** AI client this op runs under, overriding `RunOptions.ai` for this op only. */
  ai?: AIClient;
  /**
   * Retry transient provider errors (5xx / 429 / "overloaded" / "high demand")
   * for *this* op, via exponential backoff + jitter. `true` uses the defaults;
   * a {@link RetryConfig} tunes `maxRetries`/`initialDelayMs`. Off by default.
   * This is distinct from `maxRetries` above, which only re-prompts on
   * parse/validation failures — it wraps the op's effective client (the per-op
   * `ai`, else the run-wide client) in {@link withRetry}.
   */
  retry?: boolean | RetryConfig;
  /** What to do when the op throws. Default `"stop"`. */
  onError?: "stop" | "continue";
}

/**
 * Optional S1.3 gating, accepted by every `wf.ai.*` constructor. `condition`
 * decides whether the AI call runs; `gate` declares extra nodes the predicate
 * reads which are *not* passed to the AI call (a skipped gate skips the node).
 * This lets a conditional AI op — e.g. a difficulty-gated advice lane — be a
 * first-class node constructor instead of a hand-wired `wf.op` that threads the
 * gating value through its data inputs just so the condition can see it.
 *
 * `D` is the constructor's own (internal) input map, so a predicate may also read
 * the AI input itself; `G` is the gate map, inferred from `gate`.
 */
export interface AIGateOptions<D extends NodeMap, G extends NodeMap = {}> {
  gate?: G;
  condition?: Condition<D, G>;
}

/** Options for {@link AINamespace.compute}; the result type follows `output`. */
export interface AIComputeNodeOptions<K extends OutputKind> extends AINodeOptions {
  /** Plain-English description of the computation, interpolated into the prompt. */
  operation: string;
  /** Output shape — also fixes the returned node's value type via {@link AIComputeResult}. */
  output: K;
  maxTokens?: number;
  /** Custom input renderer. */
  formatInput?: (input: unknown) => string;
  /** Overrides the built-in format hint. */
  expectedFormat?: string;
  /** Semantic check run after parsing (throw to retry/repair). */
  validate?: (value: AIComputeResult<K>) => void;
}

/**
 * The object returned by `wf.ai`. Each method registers an op on the bound
 * workflow and returns its output node.
 */
export class AINamespace {
  constructor(private readonly wf: Workflow) {}

  /** Node-level wiring shared by every constructor, incl. S1.3 gate/condition. */
  private wiring<D extends NodeMap, G extends NodeMap>(
    opts: (AINodeOptions & AIGateOptions<D, G>) | undefined,
    fallbackName: string,
  ): OpDefOptions<D, G> {
    return {
      name: opts?.name ?? fallbackName,
      ai: opts?.ai,
      onError: opts?.onError,
      gate: opts?.gate,
      condition: opts?.condition,
    };
  }

  /**
   * Wraps an op body so its AI call retries transient provider errors when
   * `opts.retry` is set. The engine has already swapped `ctx.ai` to the per-op
   * client (if any) by the time the body runs, so wrapping `ctx.ai` in
   * {@link withRetry} covers both the per-op and run-wide cases. A no-op when
   * `retry` is unset or no client is in context.
   */
  private retrying<I, O>(
    opts: { retry?: boolean | RetryConfig } | undefined,
    fn: (inputs: I, ctx: RunContext) => O | Promise<O>,
  ): (inputs: I, ctx: RunContext) => O | Promise<O> {
    const r = opts?.retry;
    if (!r) return fn;
    const cfg: RetryConfig = r === true ? {} : r;
    return (inputs, ctx) => fn(inputs, ctx.ai ? withAI(ctx, withRetry(ctx.ai, cfg)) : ctx);
  }

  /** Classifies input into exactly one of a fixed set of categories. */
  modeSelect<G extends NodeMap = {}>(
    input: Node<string>,
    opts: AINodeOptions & { categories: string[] } & AIGateOptions<{ input: Node<string> }, G>,
  ): Node<string> {
    return this.wf.op(
      { input },
      this.retrying(opts, ({ input }, ctx) => modeSelect(input, opts, ctx)),
      this.wiring<{ input: Node<string> }, G>(opts, "modeSelect"),
    );
  }

  /** Answers a yes/no predicate about the input text. */
  bool<G extends NodeMap = {}>(
    input: Node<string>,
    opts: AINodeOptions & { predicate: string } & AIGateOptions<{ input: Node<string> }, G>,
  ): Node<boolean> {
    return this.wf.op(
      { input },
      this.retrying(opts, ({ input }, ctx) => aiBool(input, opts, ctx)),
      this.wiring<{ input: Node<string> }, G>(opts, "aiBool"),
    );
  }

  /** Scores text against a criterion, returning a value in [0,1]. */
  score<G extends NodeMap = {}>(
    input: Node<string>,
    opts: AINodeOptions & { criterion: string } & AIGateOptions<{ input: Node<string> }, G>,
  ): Node<number> {
    return this.wf.op(
      { input },
      this.retrying(opts, ({ input }, ctx) => aiScore(input, opts, ctx)),
      this.wiring<{ input: Node<string> }, G>(opts, "aiScore"),
    );
  }

  /** Classifies text into zero or more of a fixed set of categories. */
  classifyMultiLabel<G extends NodeMap = {}>(
    input: Node<string>,
    opts: AINodeOptions & { categories: string[] } & AIGateOptions<{ input: Node<string> }, G>,
  ): Node<string[]> {
    return this.wf.op(
      { input },
      this.retrying(opts, ({ input }, ctx) => aiClassifyMultiLabel(input, opts, ctx)),
      this.wiring<{ input: Node<string> }, G>(opts, "aiClassifyMultiLabel"),
    );
  }

  /** Selects the best-matching candidate for a query, returning its 0-based index. */
  bestMatch<G extends NodeMap = {}>(
    query: Node<string>,
    candidates: Node<string[]>,
    opts?: AINodeOptions & AIGateOptions<{ query: Node<string>; candidates: Node<string[]> }, G>,
  ): Node<number> {
    return this.wf.op(
      { query, candidates },
      this.retrying(opts, ({ query, candidates }, ctx) =>
        aiBestMatch(query, candidates, opts ?? {}, ctx)),
      this.wiring<{ query: Node<string>; candidates: Node<string[]> }, G>(opts, "aiBestMatch"),
    );
  }

  /** Reranks candidates by relevance, returning a permutation of 0-based indices. */
  rerank<G extends NodeMap = {}>(
    query: Node<string>,
    candidates: Node<string[]>,
    opts?: AINodeOptions & AIGateOptions<{ query: Node<string>; candidates: Node<string[]> }, G>,
  ): Node<number[]> {
    return this.wf.op(
      { query, candidates },
      this.retrying(opts, ({ query, candidates }, ctx) =>
        aiRerank(query, candidates, opts ?? {}, ctx)),
      this.wiring<{ query: Node<string>; candidates: Node<string[]> }, G>(opts, "aiRerank"),
    );
  }

  /** Summarizes a list of strings into a single string. */
  summarize<G extends NodeMap = {}>(
    items: Node<string[]>,
    opts: AINodeOptions & { operation: string } & AIGateOptions<{ items: Node<string[]> }, G>,
  ): Node<string> {
    return this.wf.op(
      { items },
      this.retrying(opts, ({ items }, ctx) => aiSummarize(items, opts, ctx)),
      this.wiring<{ items: Node<string[]> }, G>(opts, "aiSummarize"),
    );
  }

  /** Extracts a list of strings from arbitrary text. */
  extractStringSlice<G extends NodeMap = {}>(
    input: Node<string>,
    opts: AINodeOptions & { operation: string } & AIGateOptions<{ input: Node<string> }, G>,
  ): Node<string[]> {
    return this.wf.op(
      { input },
      this.retrying(opts, ({ input }, ctx) => aiExtractStringSlice(input, opts, ctx)),
      this.wiring<{ input: Node<string> }, G>(opts, "aiExtractStringSlice"),
    );
  }

  /** Extracts a key-value record from arbitrary text. */
  extractMap<G extends NodeMap = {}>(
    input: Node<string>,
    opts: AINodeOptions & { operation: string } & AIGateOptions<{ input: Node<string> }, G>,
  ): Node<Record<string, string>> {
    return this.wf.op(
      { input },
      this.retrying(opts, ({ input }, ctx) => aiExtractMap(input, opts, ctx)),
      this.wiring<{ input: Node<string> }, G>(opts, "aiExtractMap"),
    );
  }

  /** Converts free-form text to a number. */
  parseNumber<G extends NodeMap = {}>(
    input: Node<string>,
    opts?: AINodeOptions & { operation?: string } & AIGateOptions<{ input: Node<string> }, G>,
  ): Node<number> {
    return this.wf.op(
      { input },
      this.retrying(opts, ({ input }, ctx) => aiParseNumber(input, opts, ctx)),
      this.wiring<{ input: Node<string> }, G>(opts, "aiParseNumber"),
    );
  }

  /**
   * Generic AI compute primitive. The returned node's value type follows
   * `opts.output` (`output: "number"` → `Node<number>`), so the shape is stated
   * once — no separate type parameter to drift from the kind string.
   */
  compute<K extends OutputKind, G extends NodeMap = {}>(
    input: Node<unknown>,
    opts: AIComputeNodeOptions<K> & AIGateOptions<{ input: Node<unknown> }, G>,
  ): Node<AIComputeResult<K>> {
    return this.wf.op(
      { input },
      this.retrying(opts, ({ input }, ctx) =>
        aiCompute<AIComputeResult<K>>(
          input,
          {
            operation: opts.operation,
            output: opts.output,
            maxRetries: opts.maxRetries,
            model: opts.model,
            maxTokens: opts.maxTokens,
            formatInput: opts.formatInput,
            expectedFormat: opts.expectedFormat,
            validate: opts.validate,
            name: opts.name ?? "compute",
          },
          ctx,
        )),
      this.wiring<{ input: Node<unknown> }, G>(opts, "compute"),
    );
  }
}

const namespaces = new WeakMap<Workflow, AINamespace>();

declare module "../workflow" {
  interface Workflow {
    /**
     * Node-constructor surface for AI ops (`wf.ai.modeSelect(node, opts)`, …).
     * Installed by importing the `ai` package; see {@link AINamespace}.
     */
    readonly ai: AINamespace;
  }
}

// One namespace per workflow instance, created lazily and memoized so repeated
// `wf.ai` reads return the same object.
Object.defineProperty(Workflow.prototype, "ai", {
  configurable: true,
  get(this: Workflow): AINamespace {
    let ns = namespaces.get(this);
    if (!ns) {
      ns = new AINamespace(this);
      namespaces.set(this, ns);
    }
    return ns;
  },
});
