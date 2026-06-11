/**
 * S4b · MCP op surface: `wf.mcp.*` node constructors (Finding A, MCP tail).
 * Mirrors S2/S4a's `wf.<ns>.*` pattern — MCP ops take an input node and return an
 * output node, the engine supplies `ctx`, a single `name` flows through, and the
 * constructor folds in the one-time `setup*` (validate + prewarm) at build time.
 *
 * Op logic is driven through a FAKE in-memory session installed via
 * setMCPSessionFactory, so no subprocess/network is touched.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { Workflow, mcp } from "../src";
import type { MCPCallOutcome, MCPSession } from "../src/mcp";

/** A command guaranteed to be on PATH; validated by setup but never invoked. */
const CMD = process.platform === "win32" ? "cmd" : "sh";

afterEach(() => {
  mcp.resetMCPSessionFactory();
  mcp.resetMCPPool();
});

class FakeSession implements MCPSession {
  callCount = 0;
  lastArgs: Record<string, unknown> = {};
  constructor(
    private readonly handler: (
      name: string,
      args: Record<string, unknown>,
    ) => MCPCallOutcome | Promise<MCPCallOutcome>,
  ) {}
  async callTool(name: string, args: Record<string, unknown>): Promise<MCPCallOutcome> {
    this.callCount++;
    this.lastArgs = args;
    return this.handler(name, args);
  }
  async close(): Promise<void> {}
}

const ok = (text: string, structured?: unknown): MCPCallOutcome => ({
  text,
  isToolError: false,
  ...(structured !== undefined ? { structured } : {}),
});

function installSession(make: () => MCPSession) {
  mcp.setMCPSessionFactory(async () => make());
}

const stdio = { command: CMD, tool: "echo" } as const;

test("wf.mcp.call wires an input node to an output node (Finding A)", async () => {
  let seen: Record<string, unknown> = {};
  installSession(() =>
    new FakeSession((_name, args) => {
      seen = args;
      return ok("  hello  ");
    }),
  );
  const wf = new Workflow();
  const query = wf.input<Record<string, string>>("query");
  // No wf.op wrapper, no ctx couriering, no separate setup call, input declared once.
  const out = wf.mcp.call(query, { ...stdio, name: "search" });
  const r = await wf.run({ values: { query: { q: "alpha" } } });
  assert.equal(r.get(out), "hello"); // "string" output trims
  assert.deepEqual(seen, { q: "alpha" });
});

test("wf.mcp is memoized per workflow and distinct across instances", () => {
  const wf = new Workflow();
  assert.equal(wf.mcp, wf.mcp);
  assert.notEqual(wf.mcp, new Workflow().mcp);
});

test("the node name is the reasoning/introspection label — one name (Finding D-style)", async () => {
  installSession(() => new FakeSession(() => ok("ok")));
  const wf = new Workflow();
  const input = wf.constant<Record<string, string>>({});
  wf.mcp.call(input, { ...stdio, name: "tool_call" });
  const r = await wf.run({});
  assert.ok(r.firedNodes().some((n) => n.name === "tool_call"));
});

test("output node value type follows opts.output (number, inferred) (Finding C)", async () => {
  installSession(() => new FakeSession(() => ok("42")));
  const wf = new Workflow();
  const input = wf.constant<Record<string, string>>({});
  const out = wf.mcp.call(input, { ...stdio, output: "number" }); // Node<number>
  const r = await wf.run({});
  const v: number = r.get(out); // compiles iff inference yields number
  assert.equal(v, 42);
});

test("parseResponse overrides the output type", async () => {
  installSession(() => new FakeSession(() => ok("raw", { k: "v" })));
  const wf = new Workflow();
  const input = wf.constant<Record<string, string>>({});
  const out = wf.mcp.call(input, {
    ...stdio,
    parseResponse: (text, structured) => `${text}|${structured ? JSON.stringify(structured) : ""}`,
  }); // Node<string>
  const r = await wf.run({});
  assert.equal(r.get(out), 'raw|{"k":"v"}');
});

test("a skipped input skips the MCP node (it is a normal wf.op)", async () => {
  installSession(() => new FakeSession(() => ok("never")));
  const wf = new Workflow();
  const input = wf.op({}, () => ({}) as Record<string, string>, {
    name: "src",
    condition: () => false, // never produces → skips
  });
  const out = wf.mcp.call(input, { ...stdio, name: "downstream" });
  const r = await wf.run({});
  assert.equal(r.skipped(out), true);
});

test("wf.mcp.script wires an input node to an output node over one session", async () => {
  const session = new FakeSession((name) => ok(`pong:${name}`));
  mcp.setMCPSessionFactory(async () => session);
  const wf = new Workflow();
  const input = wf.input<string>("q");
  const out = wf.mcp.script<string, string[]>(
    input,
    {
      command: CMD,
      name: "multi",
      async script(s, value) {
        const a = await s.callTool("first", {});
        const b = await s.callTool("second", {});
        return [`${value}:${a.text}`, b.text];
      },
    },
  );
  const r = await wf.run({ values: { q: "go" } });
  assert.deepEqual(r.get(out), ["go:pong:first", "pong:second"]);
  assert.equal(session.callCount, 2);
});
