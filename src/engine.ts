import { makeContext, withAI } from "./context";
import { Pool } from "./pool";
import { SKIP } from "./types";
import type {
  Logger,
  Node,
  NodeStatus,
  ReasoningEntry,
  RunContext,
  RunOptions,
  RunResult,
  Skip,
} from "./types";
import { dependencies } from "./workflow";
import type { AnyNodeDef, Workflow } from "./workflow";

type Settled = unknown | Skip;

function isSkip(v: Settled): v is Skip {
  return v === SKIP;
}

/**
 * Deep-copies a reduce seed so each run starts from a fresh accumulator. Falls
 * back to the original value when it isn't structured-cloneable (e.g. holds a
 * function or class instance); such seeds must be treated as immutable.
 */
function cloneSeed<A>(seed: A): A {
  try {
    return structuredClone(seed);
  } catch {
    return seed;
  }
}

/** Validates the graph is acyclic and that every referenced node exists. */
function checkAcyclic(defs: ReadonlyMap<string, AnyNodeDef>): void {
  const indegree = new Map<string, number>();
  for (const id of defs.keys()) indegree.set(id, 0);
  for (const def of defs.values()) {
    for (const dep of dependencies(def)) {
      if (!defs.has(dep)) {
        throw new Error(`node "${def.name}" depends on unknown node ${dep}`);
      }
      indegree.set(def.id, (indegree.get(def.id) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  // Successors: who depends on each node.
  const successors = new Map<string, string[]>();
  for (const def of defs.values()) {
    for (const dep of dependencies(def)) {
      let list = successors.get(dep);
      if (!list) successors.set(dep, (list = []));
      list.push(def.id);
    }
  }
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    for (const succ of successors.get(id) ?? []) {
      const d = (indegree.get(succ) ?? 0) - 1;
      indegree.set(succ, d);
      if (d === 0) queue.push(succ);
    }
  }
  if (processed < defs.size) {
    throw new Error("workflow contains a cycle");
  }
}

function buildValues(
  values: RunOptions["values"],
): ReadonlyMap<string, unknown> {
  if (!values) return new Map();
  if (values instanceof Map) return values;
  return new Map(Object.entries(values));
}

/** Executes a workflow and returns its results. */
export async function execute(
  wf: Workflow,
  opts: RunOptions = {},
): Promise<RunResult> {
  const defs = wf.definitions;
  checkAcyclic(defs);

  const ac = new AbortController();
  if (opts.signal) {
    const ext = opts.signal;
    if (ext.aborted) ac.abort(ext.reason);
    else ext.addEventListener("abort", () => ac.abort(ext.reason), { once: true });
  }

  const reasoning = opts.reasoning ?? false;
  const reasoningEntries: ReasoningEntry[] = [];
  const userLogger = opts.logger;
  const logger: Logger = {
    log(e) {
      reasoningEntries.push(e);
      userLogger?.log(e);
    },
  };

  const ctx: RunContext = makeContext({
    signal: ac.signal,
    values: buildValues(opts.values),
    ai: opts.ai,
    logger: reasoning || userLogger ? logger : undefined,
    reasoning,
  });

  const pool = new Pool(opts.concurrency ?? 0);
  const memo = new Map<string, Promise<Settled>>();
  let firstError: unknown;
  const fail = (err: unknown): void => {
    if (firstError === undefined) {
      firstError = err;
      ac.abort(err);
    }
  };

  /**
   * Short-circuits scheduling once the run is aborted — by an onError:"stop"
   * failure or an external RunOptions.signal — so not-yet-started work must not
   * run, to avoid wasted or
   * duplicate side effects (extra AI/MCP calls, I/O). Records the abort as the
   * run's error so an external cancellation still rejects the run (a no-op when a
   * stop-error already set firstError), and signals the caller to skip the node.
   */
  const abortedBeforeStart = (): boolean => {
    if (!ctx.signal.aborted) return false;
    fail(ctx.signal.reason ?? new Error("run aborted"));
    return true;
  };

  function resolve(id: string): Promise<Settled> {
    const cached = memo.get(id);
    if (cached) return cached;
    const def = defs.get(id)!;
    const p = resolveDef(def);
    memo.set(id, p);
    return p;
  }

  async function resolveDef(def: AnyNodeDef): Promise<Settled> {
    switch (def.kind) {
      case "input": {
        const v = ctx.value(def.key);
        if (v !== undefined) return v;
        if (def.hasDefault) return def.default;
        throw new Error(`missing required input "${def.key}"`);
      }
      case "const":
        return def.value;
      case "op":
        return resolveOp(def);
      case "coalesce":
        return resolveCoalesce(def);
      case "zip":
        return resolveZip(def);
      case "map":
        return resolveMap(def);
      case "filter":
        return resolveFilter(def);
      case "reduce":
        return resolveReduce(def);
    }
  }

  async function resolveOp(
    def: Extract<AnyNodeDef, { kind: "op" }>,
  ): Promise<Settled> {
    const entries = Object.entries(def.inputs);
    const gateEntries = Object.entries(def.gate ?? {});
    // Resolve data inputs and gate inputs together; a skip in either skips the op.
    const values = await Promise.all(
      [...entries, ...gateEntries].map(([, depId]) => resolve(depId)),
    );
    const resolved: Record<string, unknown> = {};
    const gate: Record<string, unknown> = {};
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (isSkip(v)) return SKIP; // skip propagation
      const fromData = i < entries.length;
      const [key] = fromData ? entries[i]! : gateEntries[i - entries.length]!;
      (fromData ? resolved : gate)[key] = v;
    }
    if (abortedBeforeStart()) return SKIP;
    // A per-op AI client overrides ctx.ai for this op's condition and body, so
    // callers never reconstruct the context to redirect a single op.
    const opCtx = def.ai ? withAI(ctx, def.ai) : ctx;
    try {
      if (def.condition && !(await def.condition(resolved, gate, opCtx))) {
        return SKIP;
      }
      const out = await pool.run(async () => def.fn(resolved, opCtx));
      return out;
    } catch (err) {
      if (def.onError === "continue") return SKIP;
      fail(err);
      throw err;
    }
  }

  async function resolveCoalesce(
    def: Extract<AnyNodeDef, { kind: "coalesce" }>,
  ): Promise<Settled> {
    const values = await Promise.all(def.sources.map((s) => resolve(s)));
    for (const v of values) if (!isSkip(v)) return v;
    return SKIP;
  }

  async function resolveZip(
    def: Extract<AnyNodeDef, { kind: "zip" }>,
  ): Promise<Settled> {
    const values = await Promise.all(def.sources.map((s) => resolve(s)));
    if (values.some(isSkip)) return SKIP; // skip propagation
    const arrays = values as unknown[][];
    if (arrays.length === 0) return [];
    const len = arrays.reduce((m, a) => Math.min(m, a.length), Infinity);
    const out: unknown[][] = [];
    for (let i = 0; i < len; i++) out.push(arrays.map((a) => a[i]));
    return out;
  }

  async function resolveMap(
    def: Extract<AnyNodeDef, { kind: "map" }>,
  ): Promise<Settled> {
    const src = await resolve(def.source);
    if (isSkip(src)) return SKIP;
    if (abortedBeforeStart()) return SKIP;
    const items = src as unknown[];
    try {
      return await Promise.all(
        items.map((item) => pool.run(async () => def.fn(item, ctx))),
      );
    } catch (err) {
      if (def.onError === "continue") return SKIP;
      fail(err);
      throw err;
    }
  }

  async function resolveFilter(
    def: Extract<AnyNodeDef, { kind: "filter" }>,
  ): Promise<Settled> {
    const src = await resolve(def.source);
    if (isSkip(src)) return SKIP;
    if (abortedBeforeStart()) return SKIP;
    const items = src as unknown[];
    try {
      const keep = await Promise.all(
        items.map((item) => pool.run(async () => def.predicate(item, ctx))),
      );
      return items.filter((_, i) => keep[i]);
    } catch (err) {
      if (def.onError === "continue") return SKIP;
      fail(err);
      throw err;
    }
  }

  async function resolveReduce(
    def: Extract<AnyNodeDef, { kind: "reduce" }>,
  ): Promise<Settled> {
    const src = await resolve(def.source);
    if (isSkip(src)) return SKIP;
    if (abortedBeforeStart()) return SKIP;
    const items = src as unknown[];
    try {
      // Snapshot the build-time seed per run: a Workflow is built once and run
      // many times, so a mutable seed (e.g. [] or {}) mutated in place by the
      // reducer would otherwise leak the previous run's accumulator into the next.
      let acc = cloneSeed(def.initial);
      for (const item of items) {
        if (abortedBeforeStart()) return SKIP;
        acc = await pool.run(async () => def.reducer(acc, item, ctx));
      }
      return acc;
    } catch (err) {
      if (def.onError === "continue") return SKIP;
      fail(err);
      throw err;
    }
  }

  // Resolve every node so side-effecting ops run and errors surface.
  const ids = [...defs.keys()];
  const settled = await Promise.allSettled(ids.map((id) => resolve(id)));
  if (firstError !== undefined) throw firstError;
  // Surface errors thrown outside an op body (e.g. a missing required input),
  // which never reach the onError-handling catch and so never set firstError.
  const rejected = settled.find((r) => r.status === "rejected");
  if (rejected) throw (rejected as PromiseRejectedResult).reason;

  const resultMap = new Map<string, Settled>();
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") resultMap.set(ids[i]!, r.value);
  });

  const nodeStatuses = (): NodeStatus[] => {
    const out: NodeStatus[] = [];
    for (const [id, def] of defs) {
      const r = resultMap.get(id);
      const skipped = r === undefined || isSkip(r);
      out.push(
        skipped
          ? { id, name: def.name, kind: def.kind, skipped: true }
          : { id, name: def.name, kind: def.kind, skipped: false, value: r },
      );
    }
    return out;
  };

  return {
    get<T>(node: Node<T>): T {
      const r = resultMap.get(node.id);
      if (r === undefined || isSkip(r)) {
        throw new Error(`node "${node.name}" was skipped or not run`);
      }
      return r as T;
    },
    getOr<T>(node: Node<T>, fallback: T): T {
      const r = resultMap.get(node.id);
      if (r === undefined || isSkip(r)) return fallback;
      return r as T;
    },
    skipped(node: Node<unknown>): boolean {
      return isSkip(resultMap.get(node.id));
    },
    nodes(): NodeStatus[] {
      return nodeStatuses();
    },
    firedNodes(): NodeStatus[] {
      return nodeStatuses().filter((n) => !n.skipped);
    },
    reasoning: reasoningEntries,
  };
}
