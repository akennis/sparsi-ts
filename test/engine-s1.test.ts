/**
 * S1 · Engine/Workflow API additions: gate conditions, coalesce unions, zip,
 * source, per-op AI override, and RunResult node introspection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Workflow, SKIP } from "../src";
import type { AIClient } from "../src";

test("gate: condition reads nodes not passed to the op body", async () => {
  const wf = new Workflow();
  const cls = wf.input<string>("cls");
  const ticket = wf.input<string>("ticket");
  // The body sees only `ticket`; the predicate routes on `cls` via `gate`.
  const billing = wf.op({ ticket }, ({ ticket }) => `billing:${ticket}`, {
    gate: { cls },
    condition: (_in, { cls }) => cls === "billing",
  });
  const bug = wf.op({ ticket }, ({ ticket }) => `bug:${ticket}`, {
    gate: { cls },
    condition: (_in, { cls }) => cls === "bug",
  });

  const r = await wf.run({ values: { cls: "billing", ticket: "T1" } });
  assert.equal(r.get(billing), "billing:T1");
  assert.equal(r.skipped(bug), true);
});

test("gate: a skipped gate node skips the op", async () => {
  const wf = new Workflow();
  const ticket = wf.input<string>("ticket");
  const cls = wf.op({ ticket }, () => SKIP as never, { name: "cls" });
  const gated = wf.op({ ticket }, ({ ticket }) => ticket, {
    gate: { cls },
    condition: () => true,
  });

  assert.equal((await wf.run({ values: { ticket: "T" } })).skipped(gated), true);
});

test("coalesce returns the union of heterogeneous branch types", async () => {
  const wf = new Workflow();
  const sel = wf.input<string>("sel");
  const num = wf.op({ sel }, () => 42, { condition: ({ sel }) => sel === "n" });
  const str = wf.op({ sel }, () => "hi", { condition: ({ sel }) => sel === "s" });
  // Type-level: merged is Node<number | string>; both branches unify with no cast.
  const merged = wf.coalesce([num, str]);

  const got: number | string = (await wf.run({ values: { sel: "n" } })).get(merged);
  assert.equal(got, 42);
  assert.equal((await wf.run({ values: { sel: "s" } })).get(merged), "hi");
});

test("zip combines array nodes into typed tuples, truncating to the shortest", async () => {
  const wf = new Workflow();
  const names = wf.constant(["a", "b", "c"]);
  const flags = wf.constant([true, false]); // shorter → truncates the result
  const zipped = wf.zip([names, flags]);
  const labelled = wf.map(zipped, ([name, on]) => `${name}=${on}`);

  const r = await wf.run();
  assert.deepEqual(r.get(zipped), [
    ["a", true],
    ["b", false],
  ]);
  assert.deepEqual(r.get(labelled), ["a=true", "b=false"]);
});

test("zip skips when any source skipped", async () => {
  const wf = new Workflow();
  const a = wf.constant([1, 2]);
  const b = wf.op({ a }, () => SKIP as never, { name: "b" });
  const zipped = wf.zip([a, b]);

  assert.equal((await wf.run()).skipped(zipped), true);
});

test("source produces a value from ctx with no input map", async () => {
  const wf = new Workflow();
  const seed = wf.source((ctx) => ctx.value<number>("seed") ?? 0, { name: "seed" });
  const next = wf.op({ seed }, ({ seed }) => seed + 1);

  assert.equal((await wf.run({ values: { seed: 9 } })).get(next), 10);
});

test("per-op ai option overrides ctx.ai for that op only", async () => {
  const make = (tag: string): AIClient => ({
    defaultModel: "mock",
    async call() {
      return { text: tag };
    },
  });
  const base = make("base");
  const special = make("special");

  const wf = new Workflow();
  const usesBase = wf.op({}, async (_in, ctx) => (await ctx.ai!.call({ messages: [] })).text, {
    name: "usesBase",
  });
  const usesSpecial = wf.op(
    {},
    async (_in, ctx) => (await ctx.ai!.call({ messages: [] })).text,
    { name: "usesSpecial", ai: special },
  );

  const r = await wf.run({ ai: base });
  assert.equal(r.get(usesBase), "base");
  assert.equal(r.get(usesSpecial), "special");
});

test("RunResult.nodes / firedNodes enumerate names, kinds, and skip status", async () => {
  const wf = new Workflow();
  const sel = wf.input<string>("sel");
  wf.op({ sel }, () => "L", { name: "left", condition: ({ sel }) => sel === "l" });
  wf.op({ sel }, () => "R", { name: "right", condition: ({ sel }) => sel === "r" });

  const r = await wf.run({ values: { sel: "r" } });
  const fired = r.firedNodes().map((n) => n.name);
  assert.ok(fired.includes("right"));
  assert.ok(!fired.includes("left"));

  const left = r.nodes().find((n) => n.name === "left")!;
  assert.equal(left.skipped, true);
  assert.equal(left.kind, "op");
  assert.equal(left.value, undefined);

  const right = r.nodes().find((n) => n.name === "right")!;
  assert.equal(right.skipped, false);
  assert.equal(right.value, "R");
});
