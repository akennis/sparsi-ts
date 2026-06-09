import { test } from "node:test";
import assert from "node:assert/strict";
import { ops } from "../src";

const { num, text, bool, predicate, select, slice, json, io, time } = ops;

// ── Math — float (sparsi-go math_ops.go) ─────────────────────────────────────

test("math float ops", () => {
  assert.equal(num.addFloat(2, 3), 5);
  assert.equal(num.subFloat(5, 2), 3);
  assert.equal(num.mulFloat(4, 2.5), 10);
  assert.equal(num.divFloat(7, 2), 3.5);
  assert.throws(() => num.divFloat(1, 0), /division by zero/);
  assert.equal(num.powFloat(2, 10), 1024);
  assert.equal(num.modFloat(7, 3), 1);
  assert.throws(() => num.modFloat(1, 0), /modulo by zero/);
  assert.equal(num.sumFloat([1, 2, 3]), 6);
  assert.equal(num.minFloat([3, 1, 2]), 1);
  assert.equal(num.maxFloat([3, 1, 2]), 3);
  assert.throws(() => num.minFloat([]), /MinFloatOp: empty slice/);
  assert.throws(() => num.maxFloat([]), /MaxFloatOp: empty slice/);
  assert.deepEqual(num.packMathOperands(1, 2), { A: 1, B: 2 });
});

test("roundFloat rounds half away from zero (Go math.Round)", () => {
  assert.equal(num.roundFloat(0.5), 1);
  assert.equal(num.roundFloat(-0.5), -1);
  assert.equal(num.roundFloat(2.5), 3);
  assert.equal(num.roundFloat(-2.5), -3);
  assert.equal(num.roundFloat(2.4), 2);
});

test("clampFloat", () => {
  assert.equal(num.clampFloat(5, 1, 10), 5);
  assert.equal(num.clampFloat(-1, 1, 10), 1);
  assert.equal(num.clampFloat(11, 1, 10), 10);
});

// ── Math — int ───────────────────────────────────────────────────────────────

test("math int ops emulate Go integer semantics", () => {
  assert.equal(num.divInt(7, 2), 3); // truncates toward zero
  assert.equal(num.divInt(-7, 2), -3);
  assert.throws(() => num.divInt(1, 0), /division by zero/);
  assert.equal(num.powInt(2, 10), 1024);
  assert.equal(num.powInt(3, 0), 1);
  assert.throws(() => num.powInt(2, -1), /negative exponent for integer power/);
  assert.equal(num.modInt(7, 3), 1);
  assert.equal(num.modInt(-7, 3), -1); // sign of dividend
  assert.throws(() => num.modInt(1, 0), /modulo by zero/);
  assert.throws(() => num.minInt([]), /MinIntOp: empty slice/);
  assert.throws(() => num.maxInt([]), /MaxIntOp: empty slice/);
});

// ── Math — cast ──────────────────────────────────────────────────────────────

test("math cast ops", () => {
  assert.equal(num.intToFloat64(5), 5);
  assert.equal(num.float64ToInt(3.9), 3);
  assert.equal(num.float64ToInt(-3.9), -3);
});

test("formatGoFloat mirrors Go %v / strconv 'g'", () => {
  assert.equal(num.formatGoFloat(3.14), "3.14");
  assert.equal(num.formatGoFloat(0), "0");
  assert.equal(num.formatGoFloat(-1.5), "-1.5");
  assert.equal(num.formatGoFloat(100000), "100000");
  assert.equal(num.formatGoFloat(1e21), "1e+21");
  assert.equal(num.formatGoFloat(1e-5), "1e-05");
  assert.equal(num.formatGoFloat(1e-4), "0.0001");
  assert.equal(num.formatGoFloat(Infinity), "+Inf");
  assert.equal(num.formatGoFloat(-Infinity), "-Inf");
  assert.equal(num.formatGoFloat(NaN), "NaN");
});

test("formatMathOperands mirrors MathOperands.FormatForPrompt", () => {
  assert.equal(num.formatMathOperands({ A: 1.5, B: 2 }), "A=1.5, B=2");
});

// ── String (sparsi-go string_ops.go) ─────────────────────────────────────────

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

// ── String — cast (sparsi-go string_cast_ops.go) ─────────────────────────────

test("string cast ops", () => {
  assert.equal(text.float64ToString(3.14), "3.14");
  assert.equal(text.float64ToString(0), "0");
  assert.equal(text.float64ToString(-1.5), "-1.5");
  assert.equal(text.intToString(42), "42");
  assert.equal(text.intToString(-7), "-7");
  assert.equal(text.boolToString(true), "true");
  assert.equal(text.boolToString(false), "false");
  assert.equal(text.toString(99), "99");
  assert.equal(text.toString(true), "true");
  assert.equal(text.toString("hi"), "hi");
});

// ── Bool (sparsi-go bool_ops.go) ─────────────────────────────────────────────

test("bool ops", () => {
  assert.equal(bool.boolNot(true), false);
  assert.equal(bool.boolAnd(true, false), false);
  assert.equal(bool.boolAnd(true, true), true);
  assert.equal(bool.boolOr(false, true), true);
  assert.equal(bool.boolOr(false, false), false);
});

// ── Predicate (sparsi-go predicate_ops.go) ───────────────────────────────────

test("float predicates", () => {
  assert.equal(predicate.ifFloatGt(2, 1), true);
  assert.equal(predicate.ifFloatGt(1, 2), false);
  assert.equal(predicate.ifFloatLt(1, 2), true);
  assert.equal(predicate.ifFloatEq(1.5, 1.5), true);
  assert.equal(predicate.ifFloatGe(2, 2), true);
  assert.equal(predicate.ifFloatLe(2, 2), true);
  assert.equal(predicate.ifFloatLe(3, 2), false);
});

test("int predicates", () => {
  assert.equal(predicate.ifIntGt(2, 1), true);
  assert.equal(predicate.ifIntLt(1, 2), true);
  assert.equal(predicate.ifIntEq(5, 5), true);
  assert.equal(predicate.ifIntGe(5, 5), true);
  assert.equal(predicate.ifIntLe(6, 5), false);
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
  assert.equal(predicate.ifEmptySliceFloat64([]), true);
  assert.equal(predicate.ifEmptySliceFloat64([1]), false);
  assert.equal(predicate.betweenFloat(5, 1, 10), true);
  assert.equal(predicate.betweenFloat(1, 1, 10), true); // low boundary inclusive
  assert.equal(predicate.betweenFloat(10, 1, 10), true); // high boundary inclusive
  assert.equal(predicate.betweenFloat(0, 1, 10), false);
  assert.equal(predicate.betweenFloat(11, 1, 10), false);
});

// ── Select / Switch / Default (sparsi-go select_ops.go) ──────────────────────

test("select ops", () => {
  assert.equal(select.selectString(true, "yes", "no"), "yes");
  assert.equal(select.selectString(false, "yes", "no"), "no");
  assert.equal(select.selectFloat64(true, 1.5, 2.5), 1.5);
  assert.equal(select.selectInt(false, 10, 20), 20);
  assert.equal(select.selectBool(true, true, false), true);
});

test("switchString", () => {
  const cases = { red: "stop", green: "go", yellow: "slow" };
  assert.equal(select.switchString("green", cases, "unknown"), "go");
  assert.equal(select.switchString("purple", cases, "unknown"), "unknown");
  assert.equal(select.switchString(undefined, cases, "fallback"), "fallback");
  assert.equal(select.switchString("missing", { a: "b" }), ""); // empty default
});

test("default ops (zero is a valid value)", () => {
  assert.equal(select.defaultString(undefined, "fallback"), "fallback");
  assert.equal(select.defaultString("", "fallback"), "fallback");
  assert.equal(select.defaultString("real", "fallback"), "real");
  assert.equal(select.defaultFloat64(undefined, 99), 99);
  assert.equal(select.defaultFloat64(0, 99), 0);
  assert.equal(select.defaultInt(undefined, 7), 7);
  assert.equal(select.defaultInt(0, 7), 0);
});

// ── Slice (sparsi-go slice_ops.go) ───────────────────────────────────────────

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

// ── JSON (sparsi-go json_ops.go) ─────────────────────────────────────────────

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

// ── Time (sparsi-go time_ops.go) ─────────────────────────────────────────────

test("cityTime supports only New York and Tokyo", () => {
  const ny = time.cityTime("New York");
  assert.match(ny, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.match(time.cityTime("Tokyo"), /[+-]\d{2}:\d{2}$/);
  assert.throws(
    () => time.cityTime("Paris"),
    /CityTimeOp: unsupported city "Paris" \(supported: "New York", "Tokyo"\)/,
  );
});

// ── IO (sparsi-go io_ops.go) ─────────────────────────────────────────────────

test("getEnv returns '' when unset", () => {
  process.env.SPARSI_TEST_ENV = "present";
  assert.equal(io.getEnv("SPARSI_TEST_ENV"), "present");
  assert.equal(io.getEnv("SPARSI_DEFINITELY_UNSET_XYZ"), "");
  delete process.env.SPARSI_TEST_ENV;
});

test("fileRead wraps errors as FileReadOp", async () => {
  await assert.rejects(io.fileRead("/no/such/file/xyz.txt"), /FileReadOp:/);
});

// ── Descriptions aggregator (sparsi-go descriptions.go) ──────────────────────

test("allDescriptions renders grouped op docs in Go order", () => {
  const out = ops.allDescriptions();
  assert.ok(out.startsWith("## Math — float\n"));
  assert.ok(out.includes("## Math — int"));
  assert.ok(out.includes("## String — cast"));
  assert.ok(out.includes("## Bool"));
  assert.ok(out.includes("## Predicate — float"));
  assert.ok(out.includes("## Select / Switch / Default"));
  assert.ok(out.includes("## Slice"));
  assert.ok(out.includes("## JSON"));
  assert.ok(out.includes("AddFloatOp: deterministic float64 addition"));
});

test("allDescriptions splices Retrieval / AI / MCP groups at their Go positions", () => {
  const out = ops.allDescriptions();

  // Headers present.
  assert.ok(out.includes("## Retrieval"));
  assert.ok(out.includes("## AI"));
  assert.ok(out.includes("## MCP"));

  // Go order: Slice → Retrieval → AI → Time → IO → JSON → MCP (last).
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
