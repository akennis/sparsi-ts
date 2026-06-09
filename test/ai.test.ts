import { test } from "node:test";
import assert from "node:assert/strict";
import { Workflow, ai } from "../src";
import type { AICallRequest, RunContext, RunResult } from "../src";
import { aiCompute, ErrRepairable } from "../src/ai/compute";

/** Runs a single op that calls `fn(ctx)`, returning both the value and result. */
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

test("aiCompute parses built-in output kinds", async () => {
  const num = await runOp(new ai.MockAIClient(["42.5"]), (ctx) =>
    aiCompute<number>("two and a half dozen", { operation: "x", output: "number" }, ctx),
  );
  assert.equal(num.value, 42.5);

  const list = await runOp(new ai.MockAIClient(["a, b ,c"]), (ctx) =>
    aiCompute<string[]>("x", { operation: "x", output: "string[]" }, ctx),
  );
  assert.deepEqual(list.value, ["a", "b", "c"]);

  const map = await runOp(new ai.MockAIClient(["x=1,y=2"]), (ctx) =>
    aiCompute<Record<string, string>>("x", { operation: "x", output: "map" }, ctx),
  );
  assert.deepEqual(map.value, { x: "1", y: "2" });
});

test("aiCompute retries with parse-error feedback", async () => {
  const mock = new ai.MockAIClient(["not a number", "7"]);
  const { value } = await runOp(mock, (ctx) =>
    aiCompute<number>("x", { operation: "x", output: "number" }, ctx),
  );
  assert.equal(value, 7);
  assert.equal(mock.calls.length, 2);
  assert.match(lastUser(mock.calls[1]!), /Parse error/);
});

test("aiCompute enters conversational repair on ErrRepairable", async () => {
  const mock = new ai.MockAIClient(["bad", "GOOD"]);
  const { value } = await runOp(mock, (ctx) =>
    aiCompute<string>("x", {
      operation: "x",
      output: "string",
      validate: (v) => {
        if (v !== "GOOD") throw new ErrRepairable("Please respond with GOOD", new Error("not good"));
      },
    }, ctx),
  );
  assert.equal(value, "GOOD");
  // Second call threads history (base user, assistant 'bad') + repair prompt.
  const second = mock.calls[1]!;
  assert.equal(second.messages.length, 3);
  assert.equal(second.messages[2]!.content, "Please respond with GOOD");
  assert.equal(second.messages[1]!.role, "assistant");
  assert.equal(second.messages[1]!.content, "bad");
});

test("aiCompute reasoning envelope captures reasoning", async () => {
  const mock = new ai.MockAIClient(['{"result":"hello","reasoning":"because"}']);
  const { value, result } = await runOp(
    mock,
    (ctx) => aiCompute<string>("x", { operation: "x", output: "string", name: "myop" }, ctx),
    { reasoning: true },
  );
  assert.equal(value, "hello");
  assert.equal(result.reasoning.length, 1);
  assert.equal(result.reasoning[0]!.node, "myop");
  assert.equal(result.reasoning[0]!.reasoning, "because");
});

test("modeSelect retries until a valid category", async () => {
  const mock = new ai.MockAIClient(["nonsense", "billing"]);
  const { value } = await runOp(mock, (ctx) =>
    ai.modeSelect("refund please", { categories: ["billing", "bug"] }, ctx),
  );
  assert.equal(value, "billing");
  assert.equal(mock.calls.length, 2);
});

test("aiBool parses true/false", async () => {
  const { value } = await runOp(new ai.MockAIClient(["TRUE"]), (ctx) =>
    ai.aiBool("text", { predicate: "is it?" }, ctx),
  );
  assert.equal(value, true);
});

test("aiScore validates [0,1] range", async () => {
  const mock = new ai.MockAIClient(["1.5", "0.4"]);
  const { value } = await runOp(mock, (ctx) =>
    ai.aiScore("text", { criterion: "relevance" }, ctx),
  );
  assert.equal(value, 0.4);
  assert.equal(mock.calls.length, 2);
});

test("aiBestMatch returns an in-range index", async () => {
  const { value } = await runOp(new ai.MockAIClient(["2"]), (ctx) =>
    ai.aiBestMatch("q", ["x", "y", "z"], {}, ctx),
  );
  assert.equal(value, 2);
});

test("aiRerank validates a full permutation", async () => {
  const mock = new ai.MockAIClient(["0,0,1", "2,0,1"]);
  const { value } = await runOp(mock, (ctx) =>
    ai.aiRerank("q", ["x", "y", "z"], {}, ctx),
  );
  assert.deepEqual(value, [2, 0, 1]);
  assert.equal(mock.calls.length, 2);
});

test("integration: classify + conditional lanes + coalesce", async () => {
  const mock = new ai.MockAIClient((req) => {
    const text = lastUser(req);
    if (text.includes("Classify")) return "bug";
    if (text.includes("reproduction")) return "open app, click X, crash";
    return "";
  });

  const wf = new Workflow();
  const ticket = wf.input<string>("ticket");
  const cls = wf.op({ ticket }, ({ ticket }, ctx) =>
    ai.modeSelect(ticket, { categories: ["billing", "bug", "feature"] }, ctx),
  );
  const bug = wf.op(
    { cls, ticket },
    async ({ ticket }, ctx) => {
      const steps = await ai.aiExtractStringSlice(
        ticket,
        { operation: "extract reproduction steps" },
        ctx,
      );
      return `BUG: ${steps.join(" | ")}`;
    },
    { name: "bug", condition: ({ cls }) => cls === "bug" },
  );
  const billing = wf.op({ cls }, () => "BILLING", {
    name: "billing",
    condition: ({ cls }) => cls === "billing",
  });
  const brief = wf.coalesce([bug, billing]);

  const r = await wf.run({ ai: mock, values: { ticket: "the app crashes" } });
  assert.equal(r.get(cls), "bug");
  assert.equal(r.skipped(billing), true);
  assert.equal(r.get(brief), "BUG: open app | click X | crash");
});

function lastUser(req: AICallRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === "user") return req.messages[i]!.content;
  }
  return "";
}
