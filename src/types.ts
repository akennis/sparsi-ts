/**
 * Core contracts for the sparsi-ts DAG engine.
 *
 * A workflow is a graph of typed nodes. Every node resolves to either a value or
 * {@link SKIP}. Skips propagate downstream: an op whose inputs include a skipped
 * producer is itself skipped, unless it is a coalesce node (which skips only when
 * *all* of its producers skipped).
 */

/** Sentinel a node resolves to when it does not produce a value. */
export const SKIP: unique symbol = Symbol("sparsi.SKIP");
export type Skip = typeof SKIP;

/**
 * A typed handle to a node in a {@link Workflow}. The `__type` field is a
 * compile-time phantom and is never present at runtime.
 */
export interface Node<T = unknown> {
  readonly id: string;
  readonly name: string;
  readonly __type?: T;
}

/** A record of named input nodes wired into an op. */
export type NodeMap = Record<string, Node<any>>;

/** Resolves a {@link NodeMap} to the record of values its nodes produce. */
export type Resolved<D extends NodeMap> = {
  [K in keyof D]: D[K] extends Node<infer T> ? T : never;
};

/**
 * The function an op runs. Receives resolved inputs and the run context, returns
 * the op's output value (sync or async). Returning {@link SKIP} marks the node —
 * and everything that depends only on it — as skipped.
 */
export type OpFn<D extends NodeMap, O> = (
  inputs: Resolved<D>,
  ctx: RunContext,
) => O | Skip | Promise<O | Skip>;

/** Per-op configuration. */
export interface OpOptions {
  /** Human-readable name; defaults to an auto-generated id. */
  name?: string;
  /**
   * What to do when the op throws.
   * - `"stop"` (default): abort the run and reject.
   * - `"continue"`: treat the node as skipped and keep going.
   */
  onError?: "stop" | "continue";
}

/**
 * A single reasoning record captured when an AI op runs in reasoning mode.
 *
 * `node` is the op/node identity, `result` is the value the op produced, and
 * `inputs` is a snapshot of the op's input field values at invocation time, keyed
 * by field name — e.g. `{Input, Criterion}` for aiScore. The full set of records
 * is returned directly on {@link RunResult.reasoning} in recording order, so
 * there is no out-of-band log to correlate against.
 */
export interface ReasoningEntry {
  node: string;
  reasoning: string;
  result?: unknown;
  /** Snapshot of the op's input values at invocation time, keyed by field name. */
  inputs?: Record<string, unknown>;
}

/** Sink for reasoning records. */
export interface Logger {
  log(entry: ReasoningEntry): void;
}

/** A chat message exchanged with an AI provider. */
export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

/** A single completion request to an AI provider. */
export interface AICallRequest {
  system?: string;
  messages: AIMessage[];
  /** Overrides the client's default model for this call. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/** A completion response from an AI provider. */
export interface AICallResponse {
  text: string;
  model?: string;
  raw?: unknown;
}

/** Minimal provider contract. Implemented by AnthropicClient and MockAIClient. */
export interface AIClient {
  readonly defaultModel?: string;
  call(req: AICallRequest, signal?: AbortSignal): Promise<AICallResponse>;
}

/** Per-run state handed to every op. */
export interface RunContext {
  /** Aborted when the run fails (so in-flight ops can cancel). */
  readonly signal: AbortSignal;
  /** Out-of-band values injected via {@link RunOptions.values}. */
  value<T = unknown>(key: string): T | undefined;
  /** AI client for AI ops; undefined if none was provided. */
  readonly ai?: AIClient;
  /** Reasoning sink; present only when reasoning mode is on. */
  readonly logger?: Logger;
  /** Whether AI ops should request and capture a reasoning envelope. */
  readonly reasoning: boolean;
}

/** Options for a single {@link Workflow.run}. */
export interface RunOptions {
  ai?: AIClient;
  values?: Record<string, unknown> | ReadonlyMap<string, unknown>;
  logger?: Logger;
  reasoning?: boolean;
  /** Max ops running concurrently. Defaults to unbounded. */
  concurrency?: number;
  /** External abort signal; aborting it cancels the run. */
  signal?: AbortSignal;
}

/** The outcome of a completed run. */
export interface RunResult {
  /** The value a node produced. Throws if the node was skipped. */
  get<T>(node: Node<T>): T;
  /** The value a node produced, or `fallback` if it was skipped. */
  getOr<T>(node: Node<T>, fallback: T): T;
  /** Whether a node resolved to {@link SKIP}. */
  skipped(node: Node<unknown>): boolean;
  /** Reasoning records captured during the run, in completion order. */
  readonly reasoning: ReasoningEntry[];
}
