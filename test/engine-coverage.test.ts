/**
 * Coverage for the remaining DAG-engine branches the other engine suites miss:
 * the cloneSeed non-cloneable fallback, the reasoning/logger plumbing, zip/
 * coalesce empty-source edges, and the mid-reduce abort short-circuit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Workflow } from "../src";
import type { ReasoningEntry } from "../src";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── cloneSeed: non-structured-cloneable seed falls back to the original ────────

test("reduce with a non-cloneable seed falls back to the original value", async () => {
  const wf = new Workflow();
  const xs = wf.input<number[]>("xs");
  // A function isn't structured-cloneable, so structuredClone throws and
  // cloneSeed returns the original seed object unchanged.
  const marker = (): string => "tag";
  type Acc = { tag: () => string; sum: number };
  const red = wf.reduce(
    xs,
    (acc: Acc, x): Acc => ({ tag: acc.tag, sum: acc.sum + x }),
    { tag: marker, sum: 0 },
  );

  const r = await wf.run({ values: { xs: [1, 2, 3] } });
  assert.equal(r.get(red).sum, 6);
  assert.equal(r.get(red).tag, marker, "the un-cloned function seed is carried through");
});

// ── reasoning / logger plumbing ───────────────────────────────────────────────

test("reasoning mode collects logged entries and forwards them to a user logger", async () => {
  const seen: ReasoningEntry[] = [];
  const wf = new Workflow();
  const a = wf.input<number>("a");
  const op = wf.op(
    { a },
    ({ a }, ctx) => {
      ctx.logger?.log({ node: "op", reasoning: "computed", result: a });
      return a;
    },
    { name: "op" },
  );

  const r = await wf.run({
    values: { a: 5 },
    reasoning: true,
    logger: { log: (e) => seen.push(e) },
  });

  assert.equal(r.get(op), 5);
  assert.equal(r.reasoning.length, 1);
  assert.equal(r.reasoning[0]!.reasoning, "computed");
  assert.equal(r.reasoning[0]!.result, 5);
  assert.deepEqual(seen, r.reasoning, "the user logger receives the same entries");
});

test("a user logger without reasoning mode still receives entries", async () => {
  const seen: ReasoningEntry[] = [];
  const wf = new Workflow();
  const op = wf.op({}, (_in, ctx) => {
    ctx.logger?.log({ node: "x", reasoning: "noted" });
    return 1;
  });

  const r = await wf.run({ logger: { log: (e) => seen.push(e) } });
  assert.equal(r.get(op), 1);
  assert.equal(seen.length, 1);
  assert.equal(r.reasoning.length, 1, "the engine accumulates entries even with reasoning off");
});

test("with no logger and reasoning off, ctx.logger is undefined and reasoning is empty", async () => {
  const wf = new Workflow();
  const op = wf.op({}, (_in, ctx) => {
    assert.equal(ctx.logger, undefined);
    assert.equal(ctx.reasoning, false);
    return 1;
  });
  const r = await wf.run();
  assert.equal(r.get(op), 1);
  assert.deepEqual(r.reasoning, []);
});

// ── zip / coalesce empty-source edges ─────────────────────────────────────────

test("zip with no sources yields an empty array", async () => {
  const wf = new Workflow();
  const z = wf.zip([]);
  const r = await wf.run();
  assert.deepEqual(r.get(z), []);
});

test("coalesce with no sources skips", async () => {
  const wf = new Workflow();
  const merged = wf.coalesce([]);
  const r = await wf.run();
  assert.equal(r.skipped(merged), true);
});

test("zip of empty arrays yields an empty array (len === 0)", async () => {
  // sources is non-empty (so the no-sources early-return is bypassed), but the
  // shortest array has length 0, so the element loop never runs.
  const wf = new Workflow();
  const a = wf.constant<number[]>([]);
  const b = wf.constant<string[]>([]);
  const z = wf.zip([a, b]);
  assert.deepEqual((await wf.run()).get(z), []);
});

// ── pre-start abort short-circuits the collection operators ───────────────────

test("an already-aborted run short-circuits map / filter / reduce to skip", async () => {
  const ac = new AbortController();
  ac.abort(new Error("pre-aborted"));
  const wf = new Workflow();
  const xs = wf.constant([1, 2, 3]);
  const m = wf.map(xs, (x) => x);
  const f = wf.filter(xs, () => true);
  const red = wf.reduce(xs, (acc: number, x) => acc + x, 0);

  // The aborted run rejects before any collection operator processes its items.
  await assert.rejects(() => wf.run({ signal: ac.signal }), /pre-aborted/);

  // Re-run without the signal to confirm the nodes are otherwise well-formed.
  const ok = await wf.run();
  assert.deepEqual(ok.get(m), [1, 2, 3]);
  assert.deepEqual(ok.get(f), [1, 2, 3]);
  assert.equal(ok.get(red), 6);
});

// ── mid-reduce abort short-circuit ────────────────────────────────────────────

test("aborting during a reduce short-circuits the remaining iterations and rejects", async () => {
  const ac = new AbortController();
  const wf = new Workflow();
  const xs = wf.input<number[]>("xs");
  let calls = 0;
  const red = wf.reduce(
    xs,
    async (acc: number, x) => {
      calls++;
      ac.abort(new Error("stop mid-reduce"));
      await delay(1);
      return acc + x;
    },
    0,
  );

  await assert.rejects(
    () => wf.run({ values: { xs: [1, 2, 3] }, signal: ac.signal }),
    /stop mid-reduce/,
  );
  assert.equal(calls, 1, "the loop must stop after the iteration that aborted");
  assert.equal(red.name, "reduce");
});
