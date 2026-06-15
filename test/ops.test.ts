import { test } from "node:test";
import assert from "node:assert/strict";
import { ops } from "../src";

test("num helpers", () => {
  assert.equal(ops.num.add(2, 3), 5);
  assert.equal(ops.num.sum([1, 2, 3]), 6);
  assert.equal(ops.num.mean([2, 4]), 3);
  assert.equal(ops.num.round(3.14159, 2), 3.14);
  assert.equal(ops.num.clamp(15, 0, 10), 10);
  assert.throws(() => ops.num.div(1, 0), /division by zero/);
  assert.throws(() => ops.num.mean([]), /empty/);
});

test("text helpers", () => {
  assert.equal(ops.text.join(["a", "b"], "-"), "a-b");
  assert.equal(ops.text.replace("a.b.c", ".", "/"), "a/b/c");
  assert.equal(ops.text.template("Hi {name}, {n} msgs", { name: "Al", n: 3 }), "Hi Al, 3 msgs");
  assert.equal(ops.text.template("keep {unknown}", {}), "keep {unknown}");
});

test("predicate helpers", () => {
  assert.equal(ops.predicate.between(5, 1, 10), true);
  assert.equal(ops.predicate.and(true, true, false), false);
  assert.equal(ops.predicate.or(false, true), true);
});

test("select helpers", () => {
  assert.equal(ops.select.at([1, 2, 3], -1), 3);
  assert.equal(ops.select.last([1, 2, 3]), 3);
  assert.equal(ops.select.coalesceVal(undefined, null, 7), 7);
  assert.equal(ops.select.ifElse(true, "a", "b"), "a");
});

test("slice helpers", () => {
  assert.deepEqual(ops.slice.unique([1, 1, 2, 3, 3]), [1, 2, 3]);
  assert.deepEqual(ops.slice.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(ops.slice.zip2([1, 2, 3], ["a", "b"]), [[1, "a"], [2, "b"]]);
  assert.deepEqual(ops.slice.range(3), [0, 1, 2]);
});

test("json helpers", () => {
  assert.equal(ops.json.get({ a: { b: [10, 20] } }, "a.b.1"), 20);
  assert.equal(ops.json.get({ a: 1 }, "x.y"), undefined);
  assert.deepEqual(ops.json.merge({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.equal(ops.json.stringify({ a: 1 }), '{"a":1}');
});
