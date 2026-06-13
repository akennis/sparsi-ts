/**
 * Process-global warm-replenish MCP session pool.
 *
 * Single-threaded JS needs no locks (there are no preemptive data races): entries
 * are mutated in place, and background replenishment runs as async tasks tracked
 * in a `pending` set so shutdown can await them. Warm slots are keyed by canonical
 * spec + init timeout; a LIFO `ready` stack hands out borrows (each fresh, never
 * returned); topUp replenishes deficit = targetN − ready − inflight; replenish
 * uses bounded backoff (500ms → cap 30s) retrying until shutdown; pool size
 * converges to the max requested; after shutdown it degrades to direct start.
 *
 * Sessions are produced through the {@link createMCPSession} factory seam, so a
 * test-installed factory drives both the ops and the pool.
 */

import {
  createMCPSession,
  type MCPSession,
} from "./client";
import { type MCPTransportSpec } from "./transport";
import { errMsg } from "../internal/error";
import { warn } from "../internal/warn";
import { sleepOrAbort } from "./util";

/** Warm-session state for one canonical pool key. */
interface MCPPoolEntry {
  spec: MCPTransportSpec;
  initTimeoutMs: number;
  targetN: number;
  ready: MCPSession[]; // LIFO stack of warm sessions
  inflight: number; // replenishment tasks in progress
}

/** Canonical key: specs that match (and share an init timeout) share warm slots. */
function makeKey(spec: MCPTransportSpec, initTimeoutMs: number): string {
  return JSON.stringify([
    spec.kind,
    spec.command,
    spec.args,
    spec.env,
    spec.url,
    spec.headers,
    initTimeoutMs,
  ]);
}

class MCPPool {
  readonly aborter = new AbortController();
  readonly entries = new Map<string, MCPPoolEntry>();
  readonly pending = new Set<Promise<void>>();
  closed = false;

  /** Returns the entry for key, creating it on first use; raises targetN to max. */
  getOrCreateEntry(
    key: string,
    spec: MCPTransportSpec,
    initTimeoutMs: number,
    targetN: number,
  ): MCPPoolEntry {
    let e = this.entries.get(key);
    if (!e) {
      e = { spec, initTimeoutMs, targetN: 0, ready: [], inflight: 0 };
      this.entries.set(key, e);
    }
    if (targetN > e.targetN) e.targetN = targetN;
    return e;
  }

  /** Schedules replenishment tasks until ready+inflight reaches targetN. */
  topUp(e: MCPPoolEntry): number {
    if (this.closed) return 0;
    const deficit = e.targetN - e.ready.length - e.inflight;
    if (deficit <= 0) return 0;
    e.inflight += deficit;
    for (let i = 0; i < deficit; i++) {
      const task = this.replenishWorker(e);
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    }
    return deficit;
  }

  /**
   * Starts one session and pushes it onto e.ready. On failure, retries with
   * bounded exponential backoff until pool shutdown. Produces at most one
   * session before resolving. Decrements inflight on exactly one terminal path.
   */
  private async replenishWorker(e: MCPPoolEntry): Promise<void> {
    // Yield before any work so scheduling the worker does not run the session
    // factory inline on the caller's synchronous frame (e.g. inside acquire's hot
    // path). Without this, invoking
    // the async function would execute its prologue — including the factory
    // call — up to the first await, synchronously, before acquire returns.
    await Promise.resolve();
    let delay = 500;
    for (;;) {
      if (this.aborter.signal.aborted) {
        e.inflight--;
        return;
      }
      let sess: MCPSession;
      try {
        sess = await createMCPSession(e.spec, e.initTimeoutMs, this.aborter.signal);
      } catch (err) {
        warn(
          `mcp pool replenish failed (transport=${e.spec.kind} target=${
            e.spec.kind === "http" ? e.spec.url : e.spec.command
          }): ${errMsg(err)}`,
        );
        const { aborted } = await sleepOrAbort(delay, this.aborter.signal);
        if (aborted) {
          e.inflight--;
          return;
        }
        delay = Math.min(delay * 2, 30_000);
        continue;
      }
      if (this.closed) {
        e.inflight--;
        try {
          await sess.close();
        } catch {
          /* expected close noise at shutdown */
        }
        return;
      }
      e.ready.push(sess);
      e.inflight--;
      return;
    }
  }

  /** Removes and returns the most recently added warm session, if any (LIFO). */
  pop(e: MCPPoolEntry): MCPSession | undefined {
    return e.ready.pop();
  }
}

let globalPool = new MCPPool();

/**
 * Borrows a warm session if one is available, else starts a fresh one
 * synchronously. The caller is the sole owner and must close it; sessions are
 * never returned to the pool. Each successful acquire schedules a replenishment
 * so the steady-state warm count is preserved. `poolSize <= 0` is a passthrough
 * to {@link createMCPSession} (no pool involvement).
 */
export function acquireMCPSession(
  spec: MCPTransportSpec,
  initTimeoutMs: number,
  poolSize: number,
  signal?: AbortSignal,
): Promise<MCPSession> {
  if (poolSize <= 0) return createMCPSession(spec, initTimeoutMs, signal);
  const p = globalPool;
  if (p.closed) return createMCPSession(spec, initTimeoutMs, signal);
  const key = makeKey(spec, initTimeoutMs);
  const e = p.getOrCreateEntry(key, spec, initTimeoutMs, poolSize);
  const sess = p.pop(e);
  p.topUp(e);
  if (sess) return Promise.resolve(sess);
  return createMCPSession(spec, initTimeoutMs, signal);
}

/**
 * Schedules replenishments to fill the pool for the given spec up to `poolSize`
 * warm slots. Idempotent (converges to the max requested poolSize). No-op when
 * poolSize <= 0 or the pool is shut down.
 */
export function prewarmMCPPool(
  spec: MCPTransportSpec,
  initTimeoutMs: number,
  poolSize: number,
): void {
  if (poolSize <= 0) return;
  const p = globalPool;
  if (p.closed) return;
  const key = makeKey(spec, initTimeoutMs);
  const e = p.getOrCreateEntry(key, spec, initTimeoutMs, poolSize);
  p.topUp(e);
}

/**
 * Drains the global pool: cancels in-flight replenishments, closes idle warm
 * sessions, and waits for replenishment tasks to settle. Borrowed sessions are
 * untouched (owned by the caller). Safe to call multiple times. After shutdown,
 * acquire falls through to direct start (graceful degradation).
 *
 * Pass `{ signal }` to bound the wait: if it aborts before the tasks settle, a
 * timeout error is thrown.
 */
export async function shutdownMCPPool(opts: { signal?: AbortSignal } = {}): Promise<void> {
  const p = globalPool;
  if (p.closed) return;
  p.closed = true;
  const entries = [...p.entries.values()];
  p.aborter.abort();

  for (const e of entries) {
    const ready = e.ready;
    e.ready = [];
    for (const s of ready) {
      try {
        await s.close();
      } catch {
        // Subprocess termination on stdin-close commonly returns non-zero from
        // MCP servers lacking a graceful shutdown RPC. Expected noise.
      }
    }
  }

  const pending = [...p.pending];
  if (pending.length === 0) return;
  const settled = Promise.allSettled(pending);
  const signal = opts.signal;
  if (!signal) {
    await settled;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      fn();
    };
    void settled.then(() => finish(resolve));
    const onAbort = (): void =>
      finish(() =>
        reject(
          new Error(
            `ShutdownMCPPool: timed out waiting for replenishment tasks: ${
              signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted")
            }`,
          ),
        ),
      );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ---- test support ----

/** Replaces the global pool with a fresh one (test isolation). */
export function resetMCPPool(): void {
  globalPool = new MCPPool();
}

/** Awaits all currently-scheduled replenishment tasks (test support). */
export async function awaitMCPPoolIdle(): Promise<void> {
  while (globalPool.pending.size > 0) {
    await Promise.allSettled([...globalPool.pending]);
  }
}

/** Snapshot of pool occupancy for one spec (test support). */
export function mcpPoolReadyCount(spec: MCPTransportSpec, initTimeoutMs: number): number {
  const e = globalPool.entries.get(makeKey(spec, initTimeoutMs));
  return e ? e.ready.length : 0;
}
