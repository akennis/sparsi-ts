import { test } from "node:test";
import assert from "node:assert/strict";
import { Workflow, SKIP } from "../src";

test("op pipeline resolves typed values", async () => {
  const wf = new Workflow();
  const a = wf.input<number>("a");
  const b = wf.input<number>("b");
  const sum = wf.op({ a, b }, ({ a, b }) => a + b);
  const doubled = wf.op({ sum }, ({ sum }) => sum * 2);

  const r = await wf.run({ values: { a: 3, b: 4 } });
  assert.equal(r.get(sum), 7);
  assert.equal(r.get(doubled), 14);
});

test("input default applies when value missing; missing required throws", async () => {
  const wf = new Workflow();
  const x = wf.input<number>("x", { default: 10 });
  const y = wf.op({ x }, ({ x }) => x + 1);
  assert.equal((await wf.run()).get(y), 11);

  const wf2 = new Workflow();
  const z = wf2.input<number>("z");
  wf2.op({ z }, ({ z }) => z);
  await assert.rejects(() => wf2.run(), /missing required input "z"/);
});

test("condition false skips the op and everything depending only on it", async () => {
  const wf = new Workflow();
  const n = wf.input<number>("n");
  const gated = wf.op({ n }, ({ n }) => n, { condition: ({ n }) => n > 100 });
  const downstream = wf.op({ gated }, ({ gated }) => gated + 1);

  const r = await wf.run({ values: { n: 5 } });
  assert.equal(r.skipped(gated), true);
  assert.equal(r.skipped(downstream), true);
  assert.equal(r.getOr(gated, -1), -1);
});

test("op returning SKIP propagates to dependents", async () => {
  const wf = new Workflow();
  const a = wf.input<number>("a");
  const maybe = wf.op({ a }, ({ a }) => (a > 0 ? a : SKIP));
  const dep = wf.op({ maybe }, ({ maybe }) => maybe * 2);

  const r = await wf.run({ values: { a: -1 } });
  assert.equal(r.skipped(maybe), true);
  assert.equal(r.skipped(dep), true);
});

test("coalesce picks the first non-skipped branch", async () => {
  const wf = new Workflow();
  const sel = wf.input<string>("sel");
  const left = wf.op({ sel }, () => "LEFT", { condition: ({ sel }) => sel === "l" });
  const right = wf.op({ sel }, () => "RIGHT", { condition: ({ sel }) => sel === "r" });
  const merged = wf.coalesce([left, right]);

  assert.equal((await wf.run({ values: { sel: "r" } })).get(merged), "RIGHT");
  assert.equal((await wf.run({ values: { sel: "l" } })).get(merged), "LEFT");
});

test("coalesce skips only when all branches skip", async () => {
  const wf = new Workflow();
  const sel = wf.input<string>("sel");
  const left = wf.op({ sel }, () => "LEFT", { condition: ({ sel }) => sel === "l" });
  const right = wf.op({ sel }, () => "RIGHT", { condition: ({ sel }) => sel === "r" });
  const merged = wf.coalesce([left, right]);

  assert.equal((await wf.run({ values: { sel: "x" } })).skipped(merged), true);
});

test("map / filter / reduce over an array node", async () => {
  const wf = new Workflow();
  const xs = wf.input<number[]>("xs");
  const squared = wf.map(xs, (x) => x * x);
  const evens = wf.filter(squared, (x) => x % 2 === 0);
  const total = wf.reduce(evens, (acc: number, x) => acc + x, 0);

  const r = await wf.run({ values: { xs: [1, 2, 3, 4] } });
  assert.deepEqual(r.get(squared), [1, 4, 9, 16]);
  assert.deepEqual(r.get(evens), [4, 16]);
  assert.equal(r.get(total), 20);
});

test("onError continue turns a throw into a skip; default stop rejects", async () => {
  const wf = new Workflow();
  const a = wf.input<number>("a");
  const boom = wf.op({ a }, () => {
    throw new Error("boom");
  }, { onError: "continue" });
  const safe = wf.coalesce([boom, wf.constant("fallback")]);
  const r = await wf.run({ values: { a: 1 } });
  assert.equal(r.skipped(boom), true);
  assert.equal(r.get(safe), "fallback");

  const wf2 = new Workflow();
  const x = wf2.input<number>("x");
  wf2.op({ x }, () => {
    throw new Error("hard fail");
  });
  await assert.rejects(() => wf2.run({ values: { x: 1 } }), /hard fail/);
});

test("cycle detection rejects before running", async () => {
  // Build a cycle by hand-crafting definitions (the fluent API can't express one).
  const wf = new Workflow();
  const seed = wf.constant(1);
  const a = wf.op({ seed }, ({ seed }) => seed);
  const b = wf.op({ a }, ({ a }) => a);
  // Rewire a to depend on b → cycle.
  (wf.definitions.get(a.id) as { inputs: Record<string, string> }).inputs.extra = b.id;

  await assert.rejects(() => wf.run(), /cycle/);
});

test("concurrency limit caps simultaneous ops", async () => {
  const wf = new Workflow();
  const xs = wf.input<number[]>("xs");
  let active = 0;
  let peak = 0;
  const mapped = wf.map(
    xs,
    async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return x;
    },
    {},
  );
  await wf.run({ values: { xs: [1, 2, 3, 4, 5, 6] }, concurrency: 2 });
  assert.ok(peak <= 2, `peak concurrency ${peak} should be <= 2`);
});
