/**
 * Coverage for the core DAG-engine edge cases (TC1–TC9): external-signal
 * cancellation + abort short-circuiting, map/filter/reduce error + skip handling,
 * RunResult.get throw-on-skip, unknown-node detection, Map-valued inputs,
 * empty-array + cross-run reduce seed isolation, builder option defaulting, and
 * Pool edges.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Workflow, Pool, SKIP } from "../src";
import type { Node } from "../src";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── TC1 — external RunOptions.signal cancellation + short-circuit ─────────────

test("TC1a: an already-aborted external signal rejects the run", async () => {
  const ac = new AbortController();
  ac.abort(new Error("pre-aborted"));
  const wf = new Workflow();
  const a = wf.input<number>("a");
  wf.op({ a }, ({ a }) => a + 1);
  await assert.rejects(() => wf.run({ values: { a: 1 }, signal: ac.signal }), /pre-aborted/);
});

test("TC1b: aborting mid-run short-circuits not-yet-started dependents and rejects", async () => {
  const ac = new AbortController();
  let downstreamRan = false;
  const wf = new Workflow();
  const a = wf.input<number>("a");
  const slow = wf.op({ a }, async ({ a }) => {
    ac.abort(new Error("cancelled"));
    await delay(5);
    return a;
  });
  const downstream = wf.op({ slow }, ({ slow }) => {
    downstreamRan = true;
    return slow;
  });

  await assert.rejects(
    () => wf.run({ values: { a: 1 }, signal: ac.signal }),
    /cancelled/,
  );
  assert.equal(downstreamRan, false);
});

test("TC1c: a stop-error aborts independent not-yet-started branches", async () => {
  let independentRan = false;
  const wf = new Workflow();
  const t = wf.input<number>("t");
  // Fails synchronously on first run → aborts the controller almost immediately.
  wf.op({ t }, () => {
    throw new Error("stop now");
  });
  // Independent branch gated behind a delay so its abort check runs *after* the
  // failure has aborted the run; it must short-circuit rather than execute.
  const gate = wf.op({ t }, async () => {
    await delay(15);
    return 1;
  });
  wf.op({ gate }, () => {
    independentRan = true;
    return 1;
  });

  await assert.rejects(() => wf.run({ values: { t: 1 } }), /stop now/);
  assert.equal(independentRan, false);
});

// ── TC2 — map / filter / reduce error handling ───────────────────────────────

test("TC2: map/filter/reduce onError:'continue' skips; default rejects", async () => {
  for (const kind of ["map", "filter", "reduce"] as const) {
    const build = (onError?: "continue" | "stop"): { wf: Workflow; node: Node<unknown> } => {
      const wf = new Workflow();
      const xs = wf.input<number[]>("xs");
      const boom = (x: number): number => {
        if (x === 2) throw new Error(`${kind} boom`);
        return x;
      };
      const opts = onError ? { onError } : undefined;
      let node: Node<unknown>;
      if (kind === "map") node = wf.map(xs, boom, opts);
      else if (kind === "filter") node = wf.filter(xs, (x) => boom(x) > 0, opts);
      else node = wf.reduce(xs, (acc: number, x) => acc + boom(x), 0, opts);
      return { wf, node };
    };

    const cont = build("continue");
    const r = await cont.wf.run({ values: { xs: [1, 2, 3] } });
    assert.equal(r.skipped(cont.node), true, `${kind} continue → skip`);

    const stop = build();
    await assert.rejects(
      () => stop.wf.run({ values: { xs: [1, 2, 3] } }),
      new RegExp(`${kind} boom`),
      `${kind} default → reject`,
    );
  }
});

// ── TC3 — skip propagation through map / filter / reduce ──────────────────────

test("TC3: a skipped source node skips the map/filter/reduce node", async () => {
  for (const kind of ["map", "filter", "reduce"] as const) {
    const wf = new Workflow();
    const a = wf.input<number>("a");
    // condition false → arr is skipped → collection node must propagate skip.
    const arr = wf.op({ a }, ({ a }) => [a], { condition: ({ a }) => a > 0 });
    let node: Node<unknown>;
    if (kind === "map") node = wf.map(arr, (x) => x);
    else if (kind === "filter") node = wf.filter(arr, () => true);
    else node = wf.reduce(arr, (acc: number, x) => acc + x, 0);

    const r = await wf.run({ values: { a: -1 } });
    assert.equal(r.skipped(node), true, `${kind} skip propagation`);
  }
});

// ── TC4 — RunResult.get throws on skipped / not-run ───────────────────────────

test("TC4: get() throws on a skipped node", async () => {
  const wf = new Workflow();
  const a = wf.input<number>("a");
  const gated = wf.op({ a }, ({ a }) => a, { condition: () => false });
  const r = await wf.run({ values: { a: 1 } });
  assert.throws(() => r.get(gated), /was skipped or not run/);
});

// ── TC5 — checkAcyclic unknown-node error ─────────────────────────────────────

test("TC5: an input referencing a non-existent node rejects", async () => {
  const wf = new Workflow();
  const a = wf.op({}, () => 1);
  (wf.definitions.get(a.id) as { inputs: Record<string, string> }).inputs.ghost =
    "no-such-node";
  await assert.rejects(() => wf.run(), /depends on unknown node/);
});

// ── TC6 — values as a Map ─────────────────────────────────────────────────────

test("TC6: run accepts a Map of input values", async () => {
  const wf = new Workflow();
  const a = wf.input<number>("a");
  const o = wf.op({ a }, ({ a }) => a + 1);
  const r = await wf.run({ values: new Map<string, unknown>([["a", 5]]) });
  assert.equal(r.get(o), 6);
});

// ── TC7 — empty-array boundaries + cross-run reduce seed isolation ────────────

test("TC7: map/filter/reduce over an empty array", async () => {
  const wf = new Workflow();
  const xs = wf.input<number[]>("xs");
  const m = wf.map(xs, (x) => x * 2);
  const f = wf.filter(xs, () => true);
  const red = wf.reduce(xs, (acc: number, x) => acc + x, 0);
  const r = await wf.run({ values: { xs: [] } });
  assert.deepEqual(r.get(m), []);
  assert.deepEqual(r.get(f), []);
  assert.equal(r.get(red), 0);
});

test("TC7: a mutating reduce seed is fresh on each run", async () => {
  const wf = new Workflow();
  const ys = wf.input<number[]>("ys");
  // Reducer mutates the seed in place — the classic cross-run leak vector.
  const collected = wf.reduce(
    ys,
    (acc: number[], y) => {
      acc.push(y);
      return acc;
    },
    [] as number[],
  );

  const r1 = await wf.run({ values: { ys: [1, 2] } });
  assert.deepEqual(r1.get(collected), [1, 2]);
  const r2 = await wf.run({ values: { ys: [3, 4] } });
  assert.deepEqual(r2.get(collected), [3, 4], "second run must not inherit run 1's accumulator");
});

// ── TC8 — builder option defaulting (custom names) ────────────────────────────

test("TC8: a custom op name surfaces in the skip/not-run error", async () => {
  const wf = new Workflow();
  const a = wf.input<number>("a", { name: "myinput" });
  const gated = wf.op({ a }, ({ a }) => a, { name: "mygate", condition: () => false });
  const r = await wf.run({ values: { a: 1 } });
  assert.equal(r.skipped(gated), true);
  assert.throws(() => r.get(gated), /node "mygate"/);
});

test("TC8: a custom constant name is carried on the node", async () => {
  const wf = new Workflow();
  const c = wf.constant(42, "answer");
  assert.equal(c.name, "answer");
  const r = await wf.run();
  assert.equal(r.get(c), 42);
});

// ── TC9 — Pool non-finite / unbounded + bounded fan-out of plain ops ──────────

test("TC9: an unbounded Pool runs immediately", async () => {
  for (const limit of [Number.POSITIVE_INFINITY, 0, -1]) {
    const p = new Pool(limit);
    assert.equal(await p.run(async () => 7), 7);
  }
});

test("TC9: a bounded pool caps concurrency across parallel plain ops", async () => {
  const wf = new Workflow();
  const t = wf.input<number>("t");
  let active = 0;
  let peak = 0;
  const mkOp = (): Node<number> =>
    wf.op({ t }, async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(10);
      active--;
      return 1;
    });
  [mkOp(), mkOp(), mkOp(), mkOp(), mkOp(), mkOp()];
  await wf.run({ values: { t: 1 }, concurrency: 2 });
  assert.ok(peak <= 2, `peak concurrency ${peak} should be <= 2`);
  assert.ok(peak >= 2, `expected the pool to reach its limit, got ${peak}`);
});
