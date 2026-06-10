/**
 * Reasoning-log coverage.
 *
 * The RunOptions.reasoning flag turns on a per-run logger the engine installs;
 * the collected records surface on RunResult.reasoning in completion (recording)
 * order. These tests exercise that surface through real AI ops driven by a
 * MockAIClient: empty-by-default, single/multiple-entry shape
 * (node/inputs/result/reasoning), recording order, the inputs snapshot, the
 * disabled-is-a-noop rule, and lossless appends under concurrency.
 *
 * RunResult.reasoning is exposed once, after run() resolves, as a single final
 * snapshot — there is no live internal log to desync from, so a separate
 * defensive-copy test is unnecessary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Workflow, ai } from "../src";
import type { RunContext, RunResult } from "../src";
import { aiCompute } from "../src/ai/compute";

/** Runs one op that calls `fn(ctx)`, returning the produced value and result. */
async function runOp<O>(
  client: ai.MockAIClient,
  fn: (ctx: RunContext) => O | Promise<O>,
  runOpts: { reasoning?: boolean } = {},
): Promise<{ value: O; result: RunResult }> {
  const wf = new Workflow();
  const node = wf.op({}, (_inputs, ctx) => fn(ctx));
  const result = await wf.run({ ai: client, ...runOpts });
  return { value: result.get(node), result };
}

// ---- disabled is a no-op (≈ NoopOnPlainContext / logFromCtx nil) ----

test("reasoning disabled records nothing", async () => {
  const mock = new ai.MockAIClient(["0.1"]); // plain (non-envelope) reply
  const { result } = await runOp(mock, (ctx) =>
    ai.aiScore("text", { criterion: "toxicity" }, ctx),
  );
  assert.equal(result.reasoning.length, 0);
});

// ---- empty by default (≈ TestReasoningLog_EmptyByDefault) ----

test("reasoning enabled but no AI op records nothing", async () => {
  const wf = new Workflow();
  const c = wf.constant(7);
  const node = wf.op({ c }, ({ c }) => c * 2);
  const result = await wf.run({ reasoning: true });
  assert.equal(result.get(node), 14);
  assert.equal(result.reasoning.length, 0);
});

// ---- single entry shape + Inputs snapshot (≈ SingleEntry + InputsPreserved) ----

test("a single AI op records one entry with node/inputs/result/reasoning", async () => {
  const mock = new ai.MockAIClient(['{"score": 0.1, "reasoning": "low toxicity"}']);
  const { value, result } = await runOp(
    mock,
    (ctx) => ai.aiScore("hello world", { criterion: "toxicity" }, ctx),
    { reasoning: true },
  );
  assert.equal(value, 0.1);
  assert.equal(result.reasoning.length, 1);
  const e = result.reasoning[0]!;
  assert.equal(e.node, "aiScore");
  assert.equal(e.reasoning, "low toxicity");
  assert.equal(e.result, 0.1);
  // aiScore records the {Input, Criterion} snapshot.
  assert.equal(e.inputs?.Input, "hello world");
  assert.equal(e.inputs?.Criterion, "toxicity");
});

// ---- recording order (≈ TestReasoningLog_MultipleEntriesAllAppended) ----

test("entries are appended in completion order", async () => {
  const mock = new ai.MockAIClient([
    '{"result": "a", "reasoning": "reason A"}',
    '{"result": "b", "reasoning": "reason B"}',
    '{"result": "c", "reasoning": "reason C"}',
  ]);
  const { result } = await runOp(
    mock,
    async (ctx) => {
      // Sequential awaits guarantee a deterministic A→B→C recording order.
      await aiCompute<string>("x", { operation: "x", output: "string", name: "opA" }, ctx);
      await aiCompute<string>("x", { operation: "x", output: "string", name: "opB" }, ctx);
      await aiCompute<string>("x", { operation: "x", output: "string", name: "opC" }, ctx);
      return "done";
    },
    { reasoning: true },
  );
  assert.deepEqual(
    result.reasoning.map((e) => e.node),
    ["opA", "opB", "opC"],
  );
  assert.deepEqual(
    result.reasoning.map((e) => e.reasoning),
    ["reason A", "reason B", "reason C"],
  );
});

// ---- concurrency: lossless appends (≈ TestReasoningLog_ConcurrentRecord) ----

test("all parallel AI ops record without loss", async () => {
  const n = 100;
  // Single scripted reply: every call (by index) resolves to the same envelope.
  const mock = new ai.MockAIClient(['{"result": true, "reasoning": "r"}']);
  const { result } = await runOp(
    mock,
    async (ctx) => {
      await Promise.all(
        Array.from({ length: n }, () => ai.aiBool("text", { predicate: "is it?" }, ctx)),
      );
      return "done";
    },
    { reasoning: true },
  );
  assert.equal(result.reasoning.length, n);
  for (const e of result.reasoning) assert.equal(e.node, "aiBool");
});

// ---- WithRepair records an Inputs snapshot on repair success ----

test("WithRepair records an Inputs snapshot on repair success", async () => {
  // First inner run throws ErrRepairable; the LLM returns "fixed"; the parsed
  // value re-runs the inner op successfully on attempt 1.
  const mock = new ai.MockAIClient(["fixed"]);
  const { result } = await runOp(
    mock,
    (ctx) =>
      ai.withRepair<string, string>(
        "bad",
        {
          name: "demo",
          maxAttempts: 5,
          run: (input) => {
            if (input !== "fixed") throw new ai.ErrRepairable("Please fix it", new Error("bad input"));
            return "ok:" + input;
          },
          parse: (text) => text.trim(),
        },
        ctx,
      ),
    { reasoning: true },
  );
  assert.equal(result.reasoning.length, 1);
  const e = result.reasoning[0]!;
  assert.equal(e.reasoning, "repaired after 1 attempt(s)");
  assert.equal(e.result, "ok:fixed");
  // withRepair records the {name, max_attempts} snapshot.
  assert.equal(e.inputs?.name, "demo");
  assert.equal(e.inputs?.max_attempts, 5);
});
