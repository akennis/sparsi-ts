import { execute } from "./engine";
import type {
  AIClient,
  Node,
  NodeMap,
  OpFn,
  OpOptions,
  Resolved,
  RunContext,
  RunOptions,
  RunResult,
  Skip,
} from "./types";

/**
 * A predicate gating whether an op runs. Reads the op's own resolved inputs and,
 * separately, the resolved `gate` nodes declared in {@link OpDefOptions.gate}.
 * If it returns false the op is skipped (without running its function). The gate
 * nodes are *not* passed to the op's body, so callers stop wiring an extra input
 * (and an identity passthrough) purely to make a value visible to the predicate.
 */
export type Condition<D extends NodeMap, G extends NodeMap = {}> = (
  inputs: Resolved<D>,
  gate: Resolved<G>,
  ctx: RunContext,
) => boolean | Promise<boolean>;

/** Options accepted by {@link Workflow.op}. */
export interface OpDefOptions<D extends NodeMap, G extends NodeMap = {}>
  extends OpOptions {
  /**
   * Extra nodes visible only to {@link condition}, never passed to the op's
   * body. Like data inputs, a skipped gate node skips the op.
   */
  gate?: G;
  condition?: Condition<D, G>;
}

/** Distributes over a tuple/array of nodes to the union of their value types. */
type NodeValue<N> = N extends Node<infer T> ? T : never;
/** The element type of an array-valued node. */
type ElementOf<N> = N extends Node<readonly (infer E)[]> ? E : never;

interface BaseDef {
  id: string;
  name: string;
  onError: "stop" | "continue";
}

export interface InputNodeDef extends BaseDef {
  kind: "input";
  key: string;
  hasDefault: boolean;
  default?: unknown;
}
export interface ConstNodeDef extends BaseDef {
  kind: "const";
  value: unknown;
}
export interface OpNodeDef extends BaseDef {
  kind: "op";
  inputs: Record<string, string>;
  /** Extra dependency ids visible only to `condition`, keyed by field name. */
  gate?: Record<string, string>;
  fn: OpFn<any, any>;
  condition?: Condition<any, any>;
  /** Per-op AI client override; the engine swaps `ctx.ai` for this op. */
  ai?: AIClient;
}
export interface CoalesceNodeDef extends BaseDef {
  kind: "coalesce";
  sources: string[];
}
export interface ZipNodeDef extends BaseDef {
  kind: "zip";
  sources: string[];
}
export interface MapNodeDef extends BaseDef {
  kind: "map";
  source: string;
  fn: (item: any, ctx: RunContext) => any;
}
export interface FilterNodeDef extends BaseDef {
  kind: "filter";
  source: string;
  predicate: (item: any, ctx: RunContext) => any;
}
export interface ReduceNodeDef extends BaseDef {
  kind: "reduce";
  source: string;
  reducer: (acc: any, item: any, ctx: RunContext) => any;
  initial: unknown;
}

export type AnyNodeDef =
  | InputNodeDef
  | ConstNodeDef
  | OpNodeDef
  | CoalesceNodeDef
  | ZipNodeDef
  | MapNodeDef
  | FilterNodeDef
  | ReduceNodeDef;

/** The node ids a definition reads from. */
export function dependencies(def: AnyNodeDef): string[] {
  switch (def.kind) {
    case "op":
      return [...Object.values(def.inputs), ...Object.values(def.gate ?? {})];
    case "coalesce":
    case "zip":
      return def.sources;
    case "map":
    case "filter":
    case "reduce":
      return [def.source];
    default:
      return [];
  }
}

/**
 * Builds a DAG of typed nodes. Construction is pure: nothing executes until
 * {@link Workflow.run} is called, so a workflow can be built once and run many
 * times with different inputs.
 */
export class Workflow {
  private readonly defs = new Map<string, AnyNodeDef>();
  private counter = 0;

  /** Definitions in insertion order — consumed by the engine. */
  get definitions(): ReadonlyMap<string, AnyNodeDef> {
    return this.defs;
  }

  private nextId(prefix: string): string {
    return `${prefix}#${this.counter++}`;
  }

  private add(def: AnyNodeDef): void {
    this.defs.set(def.id, def);
  }

  private handle<T>(id: string, name: string): Node<T> {
    return { id, name };
  }

  /**
   * Declares an external input, resolved from {@link RunOptions.values} by `key`.
   * If the key is absent at run time and no default was given, the run fails.
   */
  input<T>(key: string, opts?: { default?: T; name?: string }): Node<T> {
    const id = this.nextId("input");
    const def: InputNodeDef = {
      kind: "input",
      id,
      name: opts?.name ?? key,
      key,
      hasDefault: opts !== undefined && "default" in opts,
      default: opts?.default,
      onError: "stop",
    };
    this.add(def);
    return this.handle<T>(id, def.name);
  }

  /** A literal constant available to downstream ops. */
  constant<T>(value: T, name = "const"): Node<T> {
    const id = this.nextId("const");
    this.add({ kind: "const", id, name, value, onError: "stop" });
    return this.handle<T>(id, name);
  }

  /**
   * An op: a typed async function over named input nodes. Skips automatically if
   * any input is skipped, or if its `condition` returns false.
   */
  op<D extends NodeMap, O, G extends NodeMap = {}>(
    inputs: D,
    fn: OpFn<D, O>,
    opts?: OpDefOptions<D, G>,
  ): Node<O> {
    const id = this.nextId(opts?.name ?? "op");
    const inputIds: Record<string, string> = {};
    for (const [k, node] of Object.entries(inputs)) inputIds[k] = node.id;
    let gateIds: Record<string, string> | undefined;
    if (opts?.gate) {
      gateIds = {};
      for (const [k, node] of Object.entries(opts.gate)) gateIds[k] = node.id;
    }
    const def: OpNodeDef = {
      kind: "op",
      id,
      name: opts?.name ?? "op",
      inputs: inputIds,
      gate: gateIds,
      fn: fn as OpFn<any, any>,
      condition: opts?.condition as Condition<any, any> | undefined,
      ai: opts?.ai,
      onError: opts?.onError ?? "stop",
    };
    this.add(def);
    return this.handle<O>(id, def.name);
  }

  /**
   * A dependency-free producer: runs `fn` with only the run context and yields
   * its value. The idiomatic spelling of "produces a value from nothing but
   * `ctx`", without an empty input map or an unused, explicitly-typed parameter.
   */
  source<O>(
    fn: (ctx: RunContext) => O | Skip | Promise<O | Skip>,
    opts?: OpDefOptions<{}>,
  ): Node<O> {
    return this.op({}, (_inputs, ctx) => fn(ctx), opts);
  }

  /**
   * Picks the first non-skipped source's value. Skips only when *every* source
   * skipped. Use it to merge mutually exclusive conditional branches.
   *
   * The result type is the *union* of the branch value types, so branches with
   * different shapes (e.g. a billing brief vs. a bug brief) no longer have to be
   * flattened to a common type — `coalesce([a, b])` over `Node<A>` and `Node<B>`
   * yields `Node<A | B>`.
   */
  coalesce<S extends readonly Node<any>[]>(
    sources: S,
    opts?: OpOptions,
  ): Node<NodeValue<S[number]>> {
    const id = this.nextId(opts?.name ?? "coalesce");
    const def: CoalesceNodeDef = {
      kind: "coalesce",
      id,
      name: opts?.name ?? "coalesce",
      sources: sources.map((s) => s.id),
      onError: opts?.onError ?? "stop",
    };
    this.add(def);
    return this.handle<NodeValue<S[number]>>(id, def.name);
  }

  /**
   * Combines several array nodes element-wise into one array of typed tuples,
   * truncating to the shortest source. Keeps items correlated by position with
   * their types intact, replacing index loops + `as` casts when several maps
   * over one source must be recombined: `zip([titles, flags])` over
   * `Node<string[]>` and `Node<boolean[]>` yields `Node<[string, boolean][]>`.
   * Skips if any source skipped.
   */
  zip<S extends readonly Node<readonly unknown[]>[]>(
    sources: [...S],
    opts?: OpOptions,
  ): Node<{ [K in keyof S]: ElementOf<S[K]> }[]> {
    const id = this.nextId(opts?.name ?? "zip");
    const def: ZipNodeDef = {
      kind: "zip",
      id,
      name: opts?.name ?? "zip",
      sources: sources.map((s) => s.id),
      onError: opts?.onError ?? "stop",
    };
    this.add(def);
    return this.handle<{ [K in keyof S]: ElementOf<S[K]> }[]>(id, def.name);
  }

  /** Maps `fn` over each element of an array node, producing an array node. */
  map<T, O>(
    source: Node<T[]>,
    fn: (item: T, ctx: RunContext) => O | Promise<O>,
    opts?: OpOptions,
  ): Node<O[]> {
    const id = this.nextId(opts?.name ?? "map");
    const def: MapNodeDef = {
      kind: "map",
      id,
      name: opts?.name ?? "map",
      source: source.id,
      fn: fn as (item: any, ctx: RunContext) => any,
      onError: opts?.onError ?? "stop",
    };
    this.add(def);
    return this.handle<O[]>(id, def.name);
  }

  /** Keeps array elements for which `predicate` is truthy. */
  filter<T>(
    source: Node<T[]>,
    predicate: (item: T, ctx: RunContext) => boolean | Promise<boolean>,
    opts?: OpOptions,
  ): Node<T[]> {
    const id = this.nextId(opts?.name ?? "filter");
    const def: FilterNodeDef = {
      kind: "filter",
      id,
      name: opts?.name ?? "filter",
      source: source.id,
      predicate: predicate as (item: any, ctx: RunContext) => any,
      onError: opts?.onError ?? "stop",
    };
    this.add(def);
    return this.handle<T[]>(id, def.name);
  }

  /**
   * Folds an array node into a single accumulator. `initial` is required (and is
   * snapshotted per run); there is no "first element is the seed when no init
   * wire" mode — `initial` is always the seed.
   */
  reduce<T, A>(
    source: Node<T[]>,
    reducer: (acc: A, item: T, ctx: RunContext) => A | Promise<A>,
    initial: A,
    opts?: OpOptions,
  ): Node<A> {
    const id = this.nextId(opts?.name ?? "reduce");
    const def: ReduceNodeDef = {
      kind: "reduce",
      id,
      name: opts?.name ?? "reduce",
      source: source.id,
      reducer: reducer as (acc: any, item: any, ctx: RunContext) => any,
      initial,
      onError: opts?.onError ?? "stop",
    };
    this.add(def);
    return this.handle<A>(id, def.name);
  }

  /** Executes the graph. Implemented in engine.ts to keep this file pure. */
  run(opts?: RunOptions): Promise<RunResult> {
    // `execute` is statically imported; the workflow↔engine value cycle is safe
    // because it is only referenced here at call time, not at module load.
    return execute(this, opts);
  }
}
