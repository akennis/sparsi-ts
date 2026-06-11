/**
 * S2 · AI op surface: `wf.ai.*` node constructors (Finding A), `output`-inferred
 * compute result types (Finding C), single naming (Finding D), and per-op client
 * selection via `opts.ai` (resolution side of Finding B).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Workflow } from "../src";
import { ai } from "../src";
import type { AIClient } from "../src";

// A trivial scripted client: every call returns the same fixed text.
const fixed = (text: string): AIClient => ({
  defaultModel: "mock",
  async call() {
    return { text };
  },
});

// Routes the response on the prompt so several ops can share one run.
const routed = (rules: [match: string, reply: string][]): AIClient => ({
  defaultModel: "mock",
  async call(req) {
    const prompt = req.messages.map((m) => m.content).join("\n");
    const hit = rules.find(([m]) => prompt.includes(m));
    return { text: hit ? hit[1] : "" };
  },
});

test("wf.ai.modeSelect wires an input node to an output node (Finding A)", async () => {
  const wf = new Workflow();
  const ticket = wf.input<string>("ticket");
  const cls = wf.ai.modeSelect(ticket, { categories: ["billing", "bug"], name: "classify" });
  // No wf.op wrapper, no ctx couriering, the input is declared once.
  const cap = wf.op({ cls }, ({ cls }) => cls.toUpperCase());

  const r = await wf.run({ ai: fixed("billing"), values: { ticket: "charged twice" } });
  assert.equal(r.get(cls), "billing");
  assert.equal(r.get(cap), "BILLING");
});

test("wf.ai is memoized per workflow and absent across instances", () => {
  const wf = new Workflow();
  assert.equal(wf.ai, wf.ai); // same namespace object on repeated reads
  assert.notEqual(wf.ai, new Workflow().ai); // a different workflow gets its own
});

test("wf.ai.compute infers the result type from the output kind (Finding C)", async () => {
  const wf = new Workflow();
  const text = wf.input<string>("text");
  // Type-level: num is Node<number>, list is Node<string[]> — no <O> restated.
  const num = wf.ai.compute(text, { operation: "count", output: "number" });
  const list = wf.ai.compute(text, { operation: "split", output: "string[]" });
  const plusOne = wf.op({ num }, ({ num }) => num + 1); // compiles iff num is number
  const joined = wf.op({ list }, ({ list }) => list.join("-")); // compiles iff list is string[]

  const r = await wf.run({
    ai: routed([
      ["count", "41"],
      ["split", "a,b,c"],
    ]),
    values: { text: "x" },
  });
  assert.equal(r.get(num), 41);
  assert.equal(r.get(plusOne), 42);
  assert.deepEqual(r.get(list), ["a", "b", "c"]);
  assert.equal(r.get(joined), "a-b-c");
});

test("the node name is the reasoning label — one name, not two (Finding D)", async () => {
  const wf = new Workflow();
  const text = wf.input<string>("text");
  wf.ai.score(text, { criterion: "clarity", name: "clarity_score" });

  const r = await wf.run({
    ai: fixed('{"score":0.8,"reasoning":"clear enough"}'),
    values: { text: "hello" },
    reasoning: true,
  });
  assert.equal(r.reasoning.length, 1);
  assert.equal(r.reasoning[0]!.node, "clarity_score");
  // The node carries that same name in introspection — no parallel label array.
  assert.ok(r.firedNodes().some((n) => n.name === "clarity_score"));
});

test("opts.ai selects a per-op client without rebuilding ctx (Finding B)", async () => {
  const wf = new Workflow();
  const text = wf.input<string>("text");
  const base = wf.ai.modeSelect(text, { categories: ["a", "b"], name: "base" });
  const special = wf.ai.modeSelect(text, {
    categories: ["a", "b"],
    name: "special",
    ai: fixed("b"),
  });

  const r = await wf.run({ ai: fixed("a"), values: { text: "x" } });
  assert.equal(r.get(base), "a"); // run-wide client
  assert.equal(r.get(special), "b"); // per-op override
});

test("wf.ai.bestMatch / rerank take two nodes and return indices", async () => {
  const wf = new Workflow();
  const query = wf.input<string>("query");
  const candidates = wf.constant(["red", "green", "blue"]);
  const best = wf.ai.bestMatch(query, candidates, { name: "best" });
  const order = wf.ai.rerank(query, candidates, { name: "order" });

  // bestMatch and rerank prompts differ ("best matching" vs "Rerank"), so one
  // routed client serves both in a single run.
  const r = await wf.run({
    ai: routed([
      ["Rerank", "2,1,0"],
      ["best matching", "2"],
    ]),
    values: { query: "ocean" },
  });
  assert.equal(r.get(best), 2);
  assert.deepEqual(r.get(order), [2, 1, 0]);
});

test("a skipped input skips the AI node (no special-casing needed)", async () => {
  const wf = new Workflow();
  const text = wf.op({}, () => undefined as unknown as string, {
    name: "src",
    condition: () => false, // never produces → skips
  });
  const score = wf.ai.score(text, { criterion: "x", name: "score" });

  const r = await wf.run({ ai: fixed("0.5") });
  assert.equal(r.skipped(score), true);
});

test("wf.ai.compute gates on a node the AI call never reads (Option C / Finding G)", async () => {
  // A conditional AI lane: the difficulty-gated advice lanes from recipe-analyzer.
  // `gate` carries the score to the predicate without wiring it into the AI input,
  // so no identity passthrough op is needed.
  const build = () => {
    const wf = new Workflow();
    const meal = wf.input<string>("meal");
    const score = wf.input<number>("score");
    const easy = wf.ai.compute(meal, {
      operation: "easy tip",
      output: "string",
      name: "easy_advice",
      gate: { score },
      condition: (_in, { score }) => score < 20,
    });
    const hard = wf.ai.compute(meal, {
      operation: "hard tip",
      output: "string",
      name: "hard_advice",
      gate: { score },
      condition: (_in, { score }) => score >= 20,
    });
    const advice = wf.coalesce([easy, hard], { name: "advice" });
    return { wf, easy, hard, advice };
  };

  const client = routed([
    ["easy tip", "go for it"],
    ["hard tip", "mise en place"],
  ]);

  const low = build();
  const rl = await low.wf.run({ ai: client, values: { meal: "Toast", score: 5 } });
  assert.equal(rl.skipped(low.easy), false);
  assert.equal(rl.skipped(low.hard), true); // gate predicate false → skipped
  assert.equal(rl.get(low.advice), "go for it");

  const high = build();
  const rh = await high.wf.run({ ai: client, values: { meal: "Beef Wellington", score: 60 } });
  assert.equal(rh.skipped(high.easy), true);
  assert.equal(rh.get(high.advice), "mise en place");
});

test("a skipped gate node skips the AI node (gate is a dependency)", async () => {
  const wf = new Workflow();
  const text = wf.input<string>("text");
  const gate = wf.op({}, () => 1, { name: "gate_src", condition: () => false }); // skips
  const out = wf.ai.compute(text, {
    operation: "echo",
    output: "string",
    name: "out",
    gate: { gate },
    condition: (_in, { gate }) => gate > 0,
  });

  const r = await wf.run({ ai: fixed("hi"), values: { text: "x" } });
  assert.equal(r.skipped(out), true);
});

test("opts.retry retries transient provider errors on the AI node", async () => {
  // A flaky client: a 503 on the first call, then success — the per-node `retry`
  // wraps the effective client in withRetry, so the node recovers.
  let calls = 0;
  const flaky: AIClient = {
    defaultModel: "mock",
    async call() {
      calls++;
      if (calls === 1) throw new Error("503 UNAVAILABLE: high demand, try again later");
      return { text: "42" };
    },
  };
  const wf = new Workflow();
  const text = wf.input<string>("text");
  const n = wf.ai.compute(text, {
    operation: "count",
    output: "number",
    name: "count",
    retry: { maxRetries: 2, initialDelayMs: 1 },
  });

  const r = await wf.run({ ai: flaky, values: { text: "x" } });
  assert.equal(r.get(n), 42);
  assert.equal(calls, 2); // failed once, retried, succeeded
});

test("opts.retry leaves non-transient errors un-retried", async () => {
  let calls = 0;
  const broken: AIClient = {
    defaultModel: "mock",
    async call() {
      calls++;
      throw new Error("400 invalid request");
    },
  };
  const wf = new Workflow();
  const text = wf.input<string>("text");
  wf.ai.compute(text, {
    operation: "count",
    output: "number",
    name: "count",
    retry: { maxRetries: 3, initialDelayMs: 1 },
  });

  await assert.rejects(wf.run({ ai: broken, values: { text: "x" } }), /400 invalid request/);
  assert.equal(calls, 1); // not a transient error → no retry
});
