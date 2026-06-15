import { test } from "node:test";
import assert from "node:assert/strict";
import { ops } from "../src";

const { num, text, bool, predicate, select, slice, json, io, time } = ops;

// ── Math — single numeric type (no int/float split) ──────────────────────────

test("math ops operate on one numeric type", () => {
  assert.equal(num.add(2, 3), 5);
  assert.equal(num.sub(5, 2), 3);
  assert.equal(num.mul(4, 2.5), 10);
  assert.equal(num.div(7, 2), 3.5);
  assert.throws(() => num.div(1, 0), /division by zero/);
  assert.equal(num.pow(2, 10), 1024);
  assert.equal(num.mod(7, 3), 1);
  assert.equal(num.mod(-7, 3), -1); // sign of dividend
  assert.throws(() => num.mod(1, 0), /modulo by zero/);
  assert.equal(num.sum([1, 2, 3]), 6);
  assert.equal(num.min([3, 1, 2]), 1);
  assert.equal(num.max([3, 1, 2]), 3);
  assert.throws(() => num.min([]), /empty/);
  assert.throws(() => num.max([]), /empty/);
  assert.deepEqual(num.packMathOperands(1, 2), { A: 1, B: 2 });
});

test("round rounds half away from zero with places", () => {
  assert.equal(num.round(0.5), 1);
  assert.equal(num.round(-0.5), -1);
  assert.equal(num.round(2.5), 3);
  assert.equal(num.round(-2.5), -3);
  assert.equal(num.round(2.4), 2);
  assert.equal(num.round(3.14159, 2), 3.14);
});

test("clamp", () => {
  assert.equal(num.clamp(5, 1, 10), 5);
  assert.equal(num.clamp(-1, 1, 10), 1);
  assert.equal(num.clamp(11, 1, 10), 10);
});

test("trunc truncates toward zero (the single float→int bridge)", () => {
  assert.equal(num.trunc(3.9), 3);
  assert.equal(num.trunc(-3.9), -3);
  assert.equal(num.trunc(5), 5);
});

test("numberToString uses native JS formatting", () => {
  assert.equal(num.numberToString(3.14), "3.14");
  assert.equal(num.numberToString(0), "0");
  assert.equal(num.numberToString(-1.5), "-1.5");
  // Native JS formatting: 1e6 → "1000000", 1e21 → "1e+21".
  assert.equal(num.numberToString(1e6), "1000000");
  assert.equal(num.numberToString(1e21), "1e+21");
});

test("formatMathOperands mirrors MathOperands.FormatForPrompt", () => {
  assert.equal(num.formatMathOperands({ A: 1.5, B: 2 }), "A=1.5, B=2");
});

// ── String ───────────────────────────────────────────────────────────────────

test("string ops", () => {
  assert.equal(text.stringLookup({ hamburger: "ketchup" }, "hamburger"), "ketchup");
  assert.equal(text.stringLookup({ hamburger: "ketchup" }, "hotdog"), "");
  assert.equal(text.stringLookup({}, undefined), "");
  assert.equal(text.stringToLower("HeLLo"), "hello");
  assert.equal(text.stringToLower(undefined), "");
  assert.equal(text.stringConcat("ab", "cd"), "abcd");
  assert.deepEqual(text.stringSplit("a, b ,, c"), ["a", "b", "c"]);
  assert.deepEqual(text.stringSplit("a|b|c", "|"), ["a", "b", "c"]);
});

test("regex ops", () => {
  assert.equal(text.regexMatch("^\\d{3}-\\d{4}$", "555-1234"), true);
  assert.equal(text.regexMatch("^\\d{3}-\\d{4}$", "abc"), false);
  assert.throws(() => text.regexMatch("", "x"), /RegexMatchOp: pattern param is required/);
  assert.throws(() => text.regexMatch("(unclosed", "x"), /RegexMatchOp: invalid pattern/);
  assert.equal(text.regexExtract("(\\d+)", "abc123def"), "123"); // submatch group 1
  assert.equal(text.regexExtract("\\d+", "abc123def"), "123"); // whole match
  assert.equal(text.regexExtract("\\d+", "abc"), ""); // no match
});

// ── String — cast ────────────────────────────────────────────────────────────

test("string cast ops (single numberToString)", () => {
  assert.equal(text.numberToString(3.14), "3.14");
  assert.equal(text.numberToString(0), "0");
  assert.equal(text.numberToString(-1.5), "-1.5");
  assert.equal(text.numberToString(42), "42");
  assert.equal(text.numberToString(-7), "-7");
  assert.equal(text.boolToString(true), "true");
  assert.equal(text.boolToString(false), "false");
  assert.equal(text.toString(99), "99");
  assert.equal(text.toString(true), "true");
  assert.equal(text.toString("hi"), "hi");
});

// ── Bool ─────────────────────────────────────────────────────────────────────

test("bool ops", () => {
  assert.equal(bool.boolNot(true), false);
  assert.equal(bool.boolAnd(true, false), false);
  assert.equal(bool.boolAnd(true, true), true);
  assert.equal(bool.boolOr(false, true), true);
  assert.equal(bool.boolOr(false, false), false);
});

// ── Predicate ────────────────────────────────────────────────────────────────

test("numeric predicates (single family)", () => {
  assert.equal(predicate.ifGt(2, 1), true);
  assert.equal(predicate.ifGt(1, 2), false);
  assert.equal(predicate.ifLt(1, 2), true);
  assert.equal(predicate.ifEq(1.5, 1.5), true);
  assert.equal(predicate.ifGe(2, 2), true);
  assert.equal(predicate.ifLe(2, 2), true);
  assert.equal(predicate.ifLe(3, 2), false);
});

test("string predicates", () => {
  assert.equal(predicate.ifStringContains("hello world", "world"), true);
  assert.equal(predicate.ifStringContains("hello", "xyz"), false);
  assert.equal(predicate.ifStringHasPrefix("hello world", "hello"), true);
  assert.equal(predicate.ifStringHasSuffix("hello world", "world"), true);
  assert.equal(predicate.ifStringEq("a", "a"), true);
  assert.equal(predicate.ifStringRegexMatch("^\\d{3}-\\d{4}$", "555-1234"), true);
  assert.equal(predicate.ifStringRegexMatch("^\\d{3}-\\d{4}$", "abc"), false);
  assert.throws(
    () => predicate.ifStringRegexMatch("", "x"),
    /IfStringRegexMatchOp: pattern param is required/,
  );
  assert.throws(
    () => predicate.ifStringRegexMatch("(unclosed", "x"),
    /IfStringRegexMatchOp: invalid pattern/,
  );
});

test("emptiness and range predicates", () => {
  assert.equal(predicate.ifEmptyString(undefined), true);
  assert.equal(predicate.ifEmptyString(""), true);
  assert.equal(predicate.ifEmptyString("hi"), false);
  assert.equal(predicate.ifEmptySliceString(undefined), true);
  assert.equal(predicate.ifEmptySliceString([]), true);
  assert.equal(predicate.ifEmptySliceString(["a"]), false);
  assert.equal(predicate.ifEmptySliceNumber([]), true);
  assert.equal(predicate.ifEmptySliceNumber([1]), false);
  assert.equal(predicate.between(5, 1, 10), true);
  assert.equal(predicate.between(1, 1, 10), true); // low boundary inclusive
  assert.equal(predicate.between(10, 1, 10), true); // high boundary inclusive
  assert.equal(predicate.between(0, 1, 10), false);
  assert.equal(predicate.between(11, 1, 10), false);
});

// ── Select / Switch / Default ────────────────────────────────────────────────

test("select ops", () => {
  assert.equal(select.selectString(true, "yes", "no"), "yes");
  assert.equal(select.selectString(false, "yes", "no"), "no");
  assert.equal(select.selectNumber(true, 1.5, 2.5), 1.5);
  assert.equal(select.selectNumber(false, 10, 20), 20);
  assert.equal(select.selectBool(true, true, false), true);
});

test("switchString", () => {
  const cases = { red: "stop", green: "go", yellow: "slow" };
  assert.equal(select.switchString("green", cases, "unknown"), "go");
  assert.equal(select.switchString("purple", cases, "unknown"), "unknown");
  assert.equal(select.switchString(undefined, cases, "fallback"), "fallback");
  assert.equal(select.switchString("missing", { a: "b" }), ""); // empty default
});

test("default ops (zero is a valid value; null and undefined both nil, F16)", () => {
  assert.equal(select.defaultString(undefined, "fallback"), "fallback");
  assert.equal(select.defaultString(null, "fallback"), "fallback");
  assert.equal(select.defaultString("", "fallback"), "fallback");
  assert.equal(select.defaultString("real", "fallback"), "real");
  assert.equal(select.defaultNumber(undefined, 99), 99);
  assert.equal(select.defaultNumber(null, 99), 99);
  assert.equal(select.defaultNumber(0, 99), 0);
});

// ── Slice ────────────────────────────────────────────────────────────────────

test("slice ops", () => {
  assert.equal(slice.sliceLen(["a", "b", "c"]), 3);
  assert.equal(slice.sliceAt(["a", "b", "c"], 1), "b");
  assert.throws(() => slice.sliceAt(["a"], 5), /SliceAtOp: index 5 out of range \(len 1\)/);
  assert.throws(() => slice.sliceAt(["a"], -1), /SliceAtOp: index -1 out of range/);
  assert.equal(slice.sliceFirst(["x", "y"]), "x");
  assert.equal(slice.sliceLast(["x", "y"]), "y");
  assert.throws(() => slice.sliceFirst([]), /SliceFirstOp: empty slice/);
  assert.throws(() => slice.sliceLast([]), /SliceLastOp: empty slice/);
  assert.equal(slice.sliceContains(["a", "b"], "b"), true);
  assert.equal(slice.sliceContains(["a", "b"], "z"), false);
  assert.equal(slice.sliceJoin(["a", "b", "c"]), "a,b,c");
  assert.equal(slice.sliceJoin(["a", "b"], "-"), "a-b");
  assert.deepEqual(slice.sliceFilterEq(["a", "b", "a"], "a"), ["a", "a"]);
});

test("sliceTopK returns indices of highest scores, descending", () => {
  assert.deepEqual(slice.sliceTopK([0.1, 0.9, 0.5, 0.3], 2), [1, 2]);
  assert.deepEqual(slice.sliceTopK([3, 1, 2], 5), [0, 2, 1]); // k clamped to len
  assert.throws(() => slice.sliceTopK([1, 2], 0), /SliceTopKOp: invalid k/);
});

// ── JSON ─────────────────────────────────────────────────────────────────────

test("jsonExtract traverses objects and arrays", () => {
  const doc = '{"meals":[{"name":"soup"},{"name":"salad"}],"count":2,"active":true}';
  assert.equal(json.jsonExtract(doc, "meals.0.name"), "soup");
  assert.equal(json.jsonExtract(doc, "meals.1.name"), "salad");
  assert.equal(json.jsonExtract(doc, "count"), "2"); // JSON-encoded leaf
  assert.equal(json.jsonExtract(doc, "active"), "true");
});

test("jsonExtract returns '' on miss, throws when required", () => {
  const doc = '{"a":{"b":1}}';
  assert.equal(json.jsonExtract(doc, "a.z"), "");
  assert.equal(json.jsonExtract(doc, "a.b.c"), ""); // non-traversable
  assert.throws(
    () => json.jsonExtract(doc, "a.z", true),
    /JSONExtractOp: missing key "z" in path "a.z": required path missing/,
  );
  assert.throws(() => json.jsonExtract("not json", "a"), /JSONExtractOp: invalid JSON/);
});

// ── Time ─────────────────────────────────────────────────────────────────────

test("cityTime supports only New York and Tokyo", () => {
  const ny = time.cityTime("New York");
  assert.match(ny, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.match(time.cityTime("Tokyo"), /[+-]\d{2}:\d{2}$/);
  assert.throws(
    () => time.cityTime("Paris"),
    /CityTimeOp: unsupported city "Paris" \(supported: "New York", "Tokyo"\)/,
  );
});

test("cityTime reflects the exact offset across a DST boundary (F10)", () => {
  // America/New_York: EDT (-04:00) in summer, EST (-05:00) in winter.
  assert.ok(
    time.cityTime("New York", new Date("2026-07-01T12:00:00Z")).endsWith("-04:00"),
    "summer → EDT (-04:00)",
  );
  assert.ok(
    time.cityTime("New York", new Date("2026-01-01T12:00:00Z")).endsWith("-05:00"),
    "winter → EST (-05:00)",
  );
  // Tokyo has no DST: always +09:00.
  assert.ok(time.cityTime("Tokyo", new Date("2026-07-01T12:00:00Z")).endsWith("+09:00"));
});

// ── IO ───────────────────────────────────────────────────────────────────────

test("getEnv returns '' when unset", () => {
  process.env.SPARSI_TEST_ENV = "present";
  assert.equal(io.getEnv("SPARSI_TEST_ENV"), "present");
  assert.equal(io.getEnv("SPARSI_DEFINITELY_UNSET_XYZ"), "");
  delete process.env.SPARSI_TEST_ENV;
});

test("fileRead wraps errors as FileReadOp", async () => {
  await assert.rejects(io.fileRead("/no/such/file/xyz.txt"), /FileReadOp:/);
});

// ── Descriptions aggregator ──────────────────────────────────────────────────

test("allDescriptions renders grouped op docs in catalog order", () => {
  const out = ops.allDescriptions();
  assert.ok(out.startsWith("## Math\n"));
  assert.ok(!out.includes("## Math — int"), "int/float Math groups are collapsed");
  assert.ok(out.includes("## String — cast"));
  assert.ok(out.includes("## Bool"));
  assert.ok(out.includes("## Predicate — numeric"));
  assert.ok(out.includes("## Select / Switch / Default"));
  assert.ok(out.includes("## Slice"));
  assert.ok(out.includes("## JSON"));
  assert.ok(out.includes("AddOp: deterministic numeric addition"));
});

test("allDescriptions splices Retrieval / AI / MCP groups at their catalog positions", () => {
  const out = ops.allDescriptions();

  // Headers present.
  assert.ok(out.includes("## Retrieval"));
  assert.ok(out.includes("## AI"));
  assert.ok(out.includes("## MCP"));

  // Catalog order: Slice → Retrieval → AI → Time → IO → JSON → MCP (last).
  const idx = (h: string): number => {
    const i = out.indexOf(h);
    assert.notEqual(i, -1, `missing group header: ${h}`);
    return i;
  };
  assert.ok(idx("## Slice") < idx("## Retrieval"));
  assert.ok(idx("## Retrieval") < idx("## AI"));
  assert.ok(idx("## AI") < idx("## Time"));
  assert.ok(idx("## Time") < idx("## IO"));
  assert.ok(idx("## IO") < idx("## JSON"));
  assert.ok(idx("## JSON") < idx("## MCP"));
  assert.equal(out.lastIndexOf("## "), idx("## MCP")); // MCP is the final group

  // Each group's first op description (and the WithRepair tail of AI) is present.
  assert.ok(out.includes("RetrieveOp: pulls the top-k documents"));
  assert.ok(out.includes("ValidateCitationsOp: filters LLM-emitted citations"));
  assert.ok(out.includes("ModeSelectOp: AI-powered classifier"));
  assert.ok(out.includes("WithRepair: AI-driven recovery wrapper"));
  assert.ok(out.includes("MCPCallOp: invoke a single MCP server tool"));
  assert.ok(out.includes("MCPScriptOp: orchestrate a sequence of MCP tool calls"));
});
