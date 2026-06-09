import { test } from "node:test";
import assert from "node:assert/strict";
import { ai } from "../src";
import type { AICallRequest, Logger, ReasoningEntry, RunContext } from "../src";
import { ErrRepairable } from "../src/ai/compute";
import { withRepair } from "../src/ai/repair";

/** Captures reasoning records for assertions. */
class CaptureLogger implements Logger {
  readonly entries: ReasoningEntry[] = [];
  log(entry: ReasoningEntry): void {
    this.entries.push(entry);
  }
}

/** Builds a minimal RunContext backed by a MockAIClient. */
function makeCtx(
  client: ai.MockAIClient,
  opts: { logger?: Logger } = {},
): RunContext {
  return {
    signal: new AbortController().signal,
    value: () => undefined,
    ai: client,
    logger: opts.logger,
    reasoning: opts.logger !== undefined,
  };
}

interface RepairableInput {
  text: string;
}

/**
 * Mirrors the Go stubInner: a programmable inner op that records its runs and the
 * input text it saw, and can be scripted to fail (repairably or not) for the first
 * N invocations before succeeding with "ok:<text>".
 */
function makeInner(opts: {
  failures?: (Error | null)[];
  onRun?: (text: string) => void;
}): {
  state: { runs: number; out: string };
  run: (input: RepairableInput, ctx: RunContext) => string;
} {
  const failures = [...(opts.failures ?? [])];
  const state = { runs: 0, out: "" };
  const run = (input: RepairableInput): string => {
    state.runs++;
    const text = input?.text ?? "";
    opts.onRun?.(text);
    if (failures.length > 0) {
      const err = failures.shift();
      if (err) throw err;
    }
    state.out = "ok:" + text;
    return state.out;
  };
  return { state, run };
}

/** Mirrors stubRepairable.UnmarshalRepair: "ERR:" prefix => parse failure. */
const parse = (response: string): RepairableInput => {
  if (response.startsWith("ERR:")) throw new Error(response.slice(4));
  return { text: response };
};

function userPrompt(req: AICallRequest): string {
  return req.messages[req.messages.length - 1]?.content ?? "";
}

test("WithRepair: success on first try makes no LLM call", async () => {
  const client = new ai.MockAIClient([]);
  const inner = makeInner({});
  const out = await withRepair(
    { text: "good" },
    { name: "test", run: inner.run, parse },
    makeCtx(client),
  );
  assert.equal(out, "ok:good");
  assert.equal(client.calls.length, 0, "LLM must not be called on first-try success");
  assert.equal(inner.state.runs, 1);
});

test("WithRepair: non-repairable error propagates unchanged", async () => {
  const plain = new Error("plain old error");
  const client = new ai.MockAIClient([]);
  const inner = makeInner({ failures: [plain] });
  await assert.rejects(
    () => withRepair({ text: "bad" }, { name: "test", run: inner.run, parse }, makeCtx(client)),
    (err: Error) => {
      assert.equal(err, plain, "must propagate the exact error instance");
      return true;
    },
  );
  assert.equal(client.calls.length, 0, "LLM must not be called for non-repairable errors");
});

test("WithRepair: repairs then succeeds, with prompt sandwich", async () => {
  const client = new ai.MockAIClient(["fixed-by-llm"]);
  const inner = makeInner({
    failures: [new ErrRepairable("fix me", new Error("schema bad")), null],
  });
  const out = await withRepair(
    { text: "broken" },
    {
      name: "test",
      run: inner.run,
      parse,
      promptPrefix: "[prefix] ",
      promptSuffix: " [suffix]",
    },
    makeCtx(client),
  );
  assert.equal(out, "ok:fixed-by-llm", "repair value must be wired into the inner op");
  assert.equal(client.calls.length, 1);
  assert.equal(userPrompt(client.calls[0]!), "[prefix] fix me [suffix]");
  assert.equal(
    client.calls[0]!.system,
    "You are a strict data-repair assistant. Output exactly what the user asks for, with no prose, no commentary, and no markdown fences.",
  );
  assert.equal(inner.state.runs, 2, "inner runs initial + after repair");
});

test("WithRepair: max attempts exhausted", async () => {
  const rep = new ErrRepairable("fix me", new Error("still broken"));
  const client = new ai.MockAIClient(["r1", "r2", "r3"]);
  const inner = makeInner({ failures: [rep, rep, rep, rep] });
  await assert.rejects(
    () =>
      withRepair(
        { text: "broken" },
        { name: "test", run: inner.run, parse, maxAttempts: 3 },
        makeCtx(client),
      ),
    /exhausted/,
  );
  assert.equal(client.calls.length, 3);
  assert.equal(inner.state.runs, 4, "1 initial + 3 repair");
});

test("WithRepair: unparseable response counts as an attempt", async () => {
  const wiredText: string[] = [];
  const inner = makeInner({
    failures: [new ErrRepairable("fix me", new Error("broken")), null],
    onRun: (text) => wiredText.push(text),
  });
  const client = new ai.MockAIClient(["ERR:llm gibberish", "good-second-response"]);
  const out = await withRepair(
    { text: "orig" },
    { name: "test", run: inner.run, parse, maxAttempts: 3 },
    makeCtx(client),
  );
  assert.equal(out, "ok:good-second-response");
  assert.equal(client.calls.length, 2, "1 unparseable + 1 good");
  assert.equal(inner.state.runs, 2, "initial + after good repair only");
  assert.deepEqual(wiredText, ["orig", "good-second-response"]);
  assert.match(
    userPrompt(client.calls[1]!),
    /unparseable/,
    "second prompt should announce the previous failure",
  );
});

test("WithRepair: LLM API error propagates", async () => {
  const client = new ai.MockAIClient(() => {
    throw new Error("simulated API error");
  });
  const inner = makeInner({ failures: [new ErrRepairable("fix me", new Error("broken"))] });
  await assert.rejects(
    () => withRepair({ text: "orig" }, { name: "test", run: inner.run, parse }, makeCtx(client)),
    /simulated API error/,
  );
});

test("WithRepair: records reasoning on repair success", async () => {
  const logger = new CaptureLogger();
  const client = new ai.MockAIClient(["fixed"]);
  const inner = makeInner({
    failures: [new ErrRepairable("fix me", new Error("broken")), null],
  });
  await withRepair(
    { text: "broken" },
    { name: "test", run: inner.run, parse },
    makeCtx(client, { logger }),
  );
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0]!.reasoning, "repaired after 1 attempt(s)");
  assert.equal(logger.entries[0]!.result, "ok:fixed");
});

test("WithRepairDescription documents the capability", () => {
  assert.match(ai.WithRepairDescription, /^WithRepair: AI-driven recovery wrapper/);
  assert.match(ai.WithRepairDescription, /default 3/);
  assert.match(ai.WithRepairDescription, /claude-sonnet-4-6/);
});
