/**
 * MCP-op parity, mirroring sparsi-go library/mcp_call_op_test.go (plus the
 * MCPScriptOp / pool surfaces those tests' production code implies).
 *
 * The Go tests fall into three buckets, all reproduced here:
 *   1. Pure parsing/validation (Setup defaults, transport-spec, CSV) — direct calls.
 *   2. Op logic (result dispatch, retry, tool-error, args) — driven through a
 *      FAKE in-memory session installed via setMCPSessionFactory, the TS analog of
 *      Go's MCPSession interface seam.
 *   3. End-to-end against a REAL in-process MCP server over the SDK's
 *      InMemoryTransport — the faithful analog of Go's
 *      TestMCPCallOp_EndToEnd_InProcessServer / _ToolError (no subprocess, no network).
 *
 * Intentionally NOT ported: Go's SetInputField/ResetFields/InputFields field
 * interface (reflection scaffolding with no typed-TS analogue — sparsi-ts passes
 * typed `input` + `output`/`parseResponse` directly), and the live
 * stdio-subprocess / streamable-HTTP-network legs (no guaranteed MCP server
 * binary on PATH / no network in this environment). Header injection is unit-tested
 * directly via applyStaticHeaders instead of an httptest server.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { mcp } from "../src";
import type { MCPCallOutcome, MCPSession } from "../src/mcp";

/** A command guaranteed to be on PATH; validated by Setup but never invoked. */
const CMD = process.platform === "win32" ? "cmd" : "sh";

afterEach(() => {
  mcp.resetMCPSessionFactory();
  mcp.resetMCPPool();
});

/** Configurable in-memory session for the op-logic tests. */
class FakeSession implements MCPSession {
  closeCount = 0;
  callCount = 0;
  lastName = "";
  lastArgs: Record<string, unknown> = {};
  constructor(
    private readonly handler: (
      name: string,
      args: Record<string, unknown>,
    ) => MCPCallOutcome | Promise<MCPCallOutcome>,
  ) {}
  async callTool(name: string, args: Record<string, unknown>): Promise<MCPCallOutcome> {
    this.callCount++;
    this.lastName = name;
    this.lastArgs = args;
    return this.handler(name, args);
  }
  async close(): Promise<void> {
    this.closeCount++;
  }
}

const ok = (text: string, structured?: Record<string, unknown>): MCPCallOutcome => ({
  text,
  isToolError: false,
  ...(structured ? { structured } : {}),
});

// ============================================================================
// 1. Pure parsing / validation
// ============================================================================

test("parseTransportSpec defaults to stdio", () => {
  const spec = mcp.parseTransportSpec({ command: CMD }, "test");
  assert.equal(spec.kind, "stdio");
  assert.equal(spec.command, CMD);
});

test("parseTransportSpec rejects unknown transport", () => {
  assert.throws(
    () => mcp.parseTransportSpec({ transport: "bogus" as never }, "test"),
    /unknown transport/,
  );
});

test("parseTransportSpec http requires url", () => {
  assert.throws(() => mcp.parseTransportSpec({ transport: "http" }, "test"), /url/);
});

test("parseTransportSpec http rejects non-http scheme", () => {
  assert.throws(
    () => mcp.parseTransportSpec({ transport: "http", url: "ftp://example.com/mcp" }, "test"),
    /scheme/,
  );
});

test("parseTransportSpec http sorts headers (pool-key canonicalization)", () => {
  const spec = mcp.parseTransportSpec(
    {
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Z: "last", A: "first", M: "mid" },
    },
    "test",
  );
  assert.deepEqual(spec.headers, ["A=first", "M=mid", "Z=last"]);
});

test("parseTransportSpec stdio requires command", () => {
  assert.throws(() => mcp.parseTransportSpec({}, "MCPCallOp"), /command/);
});

test("parseTransportSpec stdio rejects command not on PATH", () => {
  assert.throws(
    () => mcp.parseTransportSpec({ command: "definitely-not-a-real-binary-xyz-12345" }, "test"),
    /PATH/,
  );
});

test("splitCSV trims parts and drops empties", () => {
  assert.deepEqual(mcp.splitCSV("  -y , --root , /tmp/x "), ["-y", "--root", "/tmp/x"]);
  assert.deepEqual(mcp.splitCSV(""), []);
  assert.deepEqual(mcp.splitCSV(" , , "), []);
});

test("parseKVList drops malformed entries", () => {
  assert.deepEqual(mcp.parseKVList("  FOO=bar , BAZ=qux , malformed "), {
    FOO: "bar",
    BAZ: "qux",
  });
});

test("resolveMCPConfig applies defaults", () => {
  const cfg = mcp.resolveMCPConfig({ command: CMD }, "MCPCallOp");
  assert.equal(cfg.initTimeoutMs, 10000);
  assert.equal(cfg.callTimeoutMs, 30000);
  assert.equal(cfg.maxRetries, 3);
  assert.equal(cfg.poolSize, 0);
  assert.equal(cfg.poolPrewarm, true);
});

test("resolveMCPConfig honors overrides", () => {
  const cfg = mcp.resolveMCPConfig(
    { command: CMD, initTimeoutMs: 5000, callTimeoutMs: 1500, maxRetries: 7 },
    "MCPCallOp",
  );
  assert.equal(cfg.initTimeoutMs, 5000);
  assert.equal(cfg.callTimeoutMs, 1500);
  assert.equal(cfg.maxRetries, 7);
});

test("resolveMCPConfig non-finite maxRetries falls back to 3", () => {
  const cfg = mcp.resolveMCPConfig({ command: CMD, maxRetries: Number.NaN }, "MCPCallOp");
  assert.equal(cfg.maxRetries, 3);
});

test("resolveMCPConfig rejects pool_size on http transport", () => {
  assert.throws(
    () =>
      mcp.resolveMCPConfig(
        { transport: "http", url: "https://example.com/mcp", poolSize: 1 },
        "MCPCallOp",
      ),
    /pool_size/,
  );
});

test("setupMCPCall requires a tool", () => {
  assert.throws(() => mcp.setupMCPCall({ command: CMD, tool: "" }), /tool/);
});

// ============================================================================
// 1b. Header injection (analog of the Go httptest header-injection assertion)
// ============================================================================

test("applyStaticHeaders sets missing headers but never overwrites existing", () => {
  const h = new Headers({ "Mcp-Session-Id": "protocol-owned" });
  mcp.applyStaticHeaders(h, ["X-Test-Auth=secret-token", "Mcp-Session-Id=should-not-win"]);
  assert.equal(h.get("X-Test-Auth"), "secret-token");
  assert.equal(h.get("Mcp-Session-Id"), "protocol-owned");
});

// ============================================================================
// 2. mcpCall op logic (fake session)
// ============================================================================

function installSession(make: () => MCPSession): void {
  mcp.setMCPSessionFactory(async () => make());
}

test("mcpCall returns trimmed string by default", async () => {
  installSession(() => new FakeSession(() => ok("  hello world  ")));
  const out = await mcp.mcpCall({ msg: "x" }, { command: CMD, tool: "echo" });
  assert.equal(out, "hello world");
});

test("mcpCall dispatches int / number / boolean / string[] outputs", async () => {
  installSession(() => new FakeSession(() => ok("42")));
  assert.equal(await mcp.mcpCall(null, { command: CMD, tool: "t", output: "int" }), 42);

  installSession(() => new FakeSession(() => ok("3.14")));
  assert.equal(await mcp.mcpCall(null, { command: CMD, tool: "t", output: "number" }), 3.14);

  installSession(() => new FakeSession(() => ok("true")));
  assert.equal(await mcp.mcpCall(null, { command: CMD, tool: "t", output: "boolean" }), true);

  installSession(() => new FakeSession(() => ok("a, b, c")));
  assert.deepEqual(
    await mcp.mcpCall(null, { command: CMD, tool: "t", output: "string[]" }),
    ["a", "b", "c"],
  );
});

test("mcpCall boolean output rejects an unparseable value", async () => {
  installSession(() => new FakeSession(() => ok("nope")));
  await assert.rejects(
    mcp.mcpCall(null, { command: CMD, tool: "t", output: "boolean" }),
    /expected bool/,
  );
});

test("mcpCall output 'json' prefers structured content", async () => {
  installSession(() => new FakeSession(() => ok("ignored fallback", { name: "alice", age: 30 })));
  const out = await mcp.mcpCall<unknown, { name: string; age: number }>(null, {
    command: CMD,
    tool: "t",
    output: "json",
  });
  assert.deepEqual(out, { name: "alice", age: 30 });
});

test("mcpCall output 'json' parses text JSON when no structured content", async () => {
  installSession(() => new FakeSession(() => ok('{"a":1,"b":"two"}')));
  const out = await mcp.mcpCall<unknown, { a: number; b: string }>(null, {
    command: CMD,
    tool: "t",
    output: "json",
  });
  assert.deepEqual(out, { a: 1, b: "two" });
});

test("mcpCall encodes input as the tool arguments; formatArgs overrides", async () => {
  let captured: Record<string, unknown> = {};
  installSession(
    () =>
      new FakeSession((_name, args) => {
        captured = args;
        return ok("ok");
      }),
  );
  await mcp.mcpCall({ x: "hi" }, { command: CMD, tool: "echo" });
  assert.deepEqual(captured, { x: "hi" });

  await mcp.mcpCall({ x: "hi" }, { command: CMD, tool: "echo", formatArgs: (i) => ({ q: i.x }) });
  assert.deepEqual(captured, { q: "hi" });
});

test("mcpCall encodes a nil input as an empty arguments object", async () => {
  let captured: Record<string, unknown> | undefined;
  installSession(
    () =>
      new FakeSession((_name, args) => {
        captured = args;
        return ok("ok");
      }),
  );
  await mcp.mcpCall(null, { command: CMD, tool: "echo" });
  assert.deepEqual(captured, {});
});

test("mcpCall fails immediately on a tool error (no retry)", async () => {
  let calls = 0;
  installSession(
    () =>
      new FakeSession(() => {
        calls++;
        return { text: "not allowed", isToolError: true };
      }),
  );
  await assert.rejects(
    mcp.mcpCall(null, { command: CMD, tool: "echo", maxRetries: 3 }),
    /tool "echo" reported error: not allowed/,
  );
  assert.equal(calls, 1);
});

test("mcpCall retries a transient transport failure then succeeds", async () => {
  let calls = 0;
  installSession(
    () =>
      new FakeSession(() => {
        calls++;
        if (calls === 1) throw new Error("503 service unavailable");
        return ok("recovered");
      }),
  );
  const out = await mcp.mcpCall(null, { command: CMD, tool: "echo", maxRetries: 3 });
  assert.equal(out, "recovered");
  assert.equal(calls, 2);
});

test("mcpCall exhausts retries and reports the last error", async () => {
  installSession(
    () =>
      new FakeSession(() => {
        throw new Error("always down");
      }),
  );
  await assert.rejects(
    mcp.mcpCall(null, { command: CMD, tool: "echo", maxRetries: 1 }),
    /all 2 attempts failed; last error: always down/,
  );
});

test("mcpCall parseResponse hook takes full control of parsing", async () => {
  installSession(() => new FakeSession(() => ok("raw text", { k: "v" })));
  const out = await mcp.mcpCall<unknown, string>(null, {
    command: CMD,
    tool: "t",
    parseResponse: (text, structured) => `${text}|${structured ? JSON.stringify(structured) : ""}`,
  });
  assert.equal(out, 'raw text|{"k":"v"}');
});

// ============================================================================
// 3. mcpScript op logic (fake session)
// ============================================================================

test("mcpScript runs the script once over a single reused session", async () => {
  const session = new FakeSession((name) => ok(`pong:${name}`));
  mcp.setMCPSessionFactory(async () => session);

  const out = await mcp.mcpScript<unknown, string>(null, {
    command: CMD,
    script: async (s) => {
      const a = await s.callTool("first", {});
      const b = await s.callTool("second", {});
      return `${a.text},${b.text}`;
    },
  });

  assert.equal(out, "pong:first,pong:second");
  assert.equal(session.callCount, 2); // same session reused across calls
  assert.equal(session.closeCount, 1); // torn down once, after the script
});

test("mcpScript surfaces a tool error to the script as MCPToolError", async () => {
  mcp.setMCPSessionFactory(
    async () => new FakeSession(() => ({ text: "element not found", isToolError: true })),
  );

  const out = await mcp.mcpScript<unknown, string>(null, {
    command: CMD,
    script: async (s) => {
      try {
        await s.callTool("click", { selector: "#missing" });
        return "clicked";
      } catch (err) {
        if (err instanceof mcp.MCPToolError) return `recovered:${err.tool}`;
        throw err;
      }
    },
  });
  assert.equal(out, "recovered:click");
});

test("mcpScript retries session-start failures but never the script", async () => {
  let starts = 0;
  let scriptRuns = 0;
  mcp.setMCPSessionFactory(async () => {
    starts++;
    if (starts === 1) throw new Error("connect refused");
    return new FakeSession(() => ok("ready"));
  });

  const out = await mcp.mcpScript<unknown, string>(null, {
    command: CMD,
    maxRetries: 3,
    script: async (s) => {
      scriptRuns++;
      const r = await s.callTool("go", {});
      return r.text;
    },
  });
  assert.equal(out, "ready");
  assert.equal(starts, 2); // one failed start + one success
  assert.equal(scriptRuns, 1); // script ran exactly once
});

test("mcpScript requires a script callback", () => {
  assert.throws(
    () => mcp.setupMCPScript({ command: CMD } as never),
    /Script callback is nil/,
  );
});

// ============================================================================
// 4. Warm pool
// ============================================================================

test("pool prewarms, serves a warm hit, and replenishes", async () => {
  mcp.resetMCPPool();
  const created: FakeSession[] = [];
  mcp.setMCPSessionFactory(async () => {
    const s = new FakeSession(() => ok("ok"));
    created.push(s);
    return s;
  });

  const spec = mcp.parseTransportSpec({ command: CMD }, "test");
  mcp.prewarmMCPPool(spec, 10000, 2);
  await mcp.awaitMCPPoolIdle();
  assert.equal(created.length, 2);
  assert.equal(mcp.mcpPoolReadyCount(spec, 10000), 2);

  // A warm acquire returns one of the already-prewarmed sessions (LIFO), not a
  // freshly created one — identity, not a counter, because replenishment also
  // calls the factory and its microtask can interleave with this await. (Counting
  // creations would conflate the legitimate replenishment with a hot-path start.)
  const prewarmed = created.slice();
  const sess = await mcp.acquireMCPSession(spec, 10000, 2);
  assert.ok(prewarmed.includes(sess as FakeSession)); // warm hit, not a cold start

  await mcp.awaitMCPPoolIdle();
  assert.equal(created.length, 3); // exactly one replenishment ran
  assert.equal(mcp.mcpPoolReadyCount(spec, 10000), 2); // back to target
});

test("shutdownMCPPool closes idle sessions and degrades to direct start", async () => {
  mcp.resetMCPPool();
  const sessions: FakeSession[] = [];
  mcp.setMCPSessionFactory(async () => {
    const s = new FakeSession(() => ok("ok"));
    sessions.push(s);
    return s;
  });

  const spec = mcp.parseTransportSpec({ command: CMD }, "test");
  mcp.prewarmMCPPool(spec, 10000, 2);
  await mcp.awaitMCPPoolIdle();
  assert.equal(mcp.mcpPoolReadyCount(spec, 10000), 2);

  await mcp.shutdownMCPPool();
  assert.equal(mcp.mcpPoolReadyCount(spec, 10000), 0);
  assert.ok(sessions.every((s) => s.closeCount === 1)); // idle sessions closed

  // After shutdown, acquire still works by falling through to a direct start.
  const sess = await mcp.acquireMCPSession(spec, 10000, 2);
  assert.ok(sess);
});

// ============================================================================
// 5. End-to-end against a real in-process MCP server (InMemoryTransport)
// ============================================================================

async function connectInProcess(): Promise<mcp.RealMCPSession> {
  const server = new Server(
    { name: "test-server", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (name === "echo") {
      const msg = (req.params.arguments as { msg?: unknown } | undefined)?.msg ?? "";
      return { content: [{ type: "text" as const, text: String(msg) }] };
    }
    if (name === "fail") {
      return { content: [{ type: "text" as const, text: "not allowed" }], isError: true };
    }
    return { content: [{ type: "text" as const, text: "unknown tool" }], isError: true };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return new mcp.RealMCPSession(client);
}

test("RealMCPSession.callTool echoes text over a real in-process server", async () => {
  const sess = await connectInProcess();
  try {
    const out = await sess.callTool("echo", { msg: "hi there" }, 0);
    assert.equal(out.isToolError, false);
    assert.equal(out.text, "hi there");
  } finally {
    await sess.close();
  }
});

test("RealMCPSession.callTool surfaces a server tool error", async () => {
  const sess = await connectInProcess();
  try {
    const out = await sess.callTool("fail", {}, 0);
    assert.equal(out.isToolError, true);
    assert.equal(out.text, "not allowed");
  } finally {
    await sess.close();
  }
});

// ============================================================================
// 6. Descriptions
// ============================================================================

test("MCP op descriptions expose MCPCallOp and MCPScriptOp", () => {
  assert.match(mcp.MCPCallOpDescription, /MCPCallOp:/);
  assert.match(mcp.MCPScriptOpDescription, /MCPScriptOp:/);
});
