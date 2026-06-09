/**
 * MCP session + SDK transport construction — the layer that touches the
 * `@modelcontextprotocol/sdk`.
 *
 * Faithful port of sparsi-go's mcp_client.go (mcpSession, buildTransport,
 * httpClientWithHeaders/headerInjectingTransport, startMCPSessionFromSpec,
 * callTool, close) and the MCPSession/MCPToolError surface from
 * mcp_script_op.go. Go's `*exec.Cmd` bound to ctx and `*http.Client` with a
 * header-injecting RoundTripper become, respectively, the SDK's
 * StdioClientTransport and a StreamableHTTPClientTransport with a header-injecting
 * `fetch`. The SDK is reached only through its public `.js` subpaths so the code
 * both typechecks under classic module resolution and runs under CommonJS.
 *
 * A module-level session-factory seam ({@link createMCPSession} /
 * {@link setMCPSessionFactory}) lets tests inject fake in-memory sessions while
 * production uses {@link startMCPSessionFromSpec}.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport, FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";

import { mcpLabel, type MCPTransportSpec } from "./transport";

/** Tool-call result after content has been split into text vs. structured forms. */
export interface MCPCallOutcome {
  /** Concatenated text content (TextContent blocks joined with "\n"). */
  text: string;
  /** Structured content object, or undefined if the tool emitted none. */
  structured?: Record<string, unknown>;
  /** True when the server reported a tool-level error (CallToolResult.isError). */
  isToolError: boolean;
}

/**
 * One live MCP client session. Each {@link callTool} reuses the same underlying
 * subprocess/connection, so server-side state persists across calls within a
 * single session (the contract MCPScriptOp relies on).
 */
export interface MCPSession {
  callTool(
    name: string,
    args: Record<string, unknown>,
    callTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<MCPCallOutcome>;
  close(): Promise<void>;
}

/**
 * Thrown by {@link mcpScript}'s session adapter when the server reports a
 * tool-level error (isError=true). Scripts can `instanceof`-check this to recover
 * from anticipated failures (e.g. element-not-found on a click). Mirrors Go's
 * `*MCPToolError`.
 */
export class MCPToolError extends Error {
  constructor(
    readonly tool: string,
    readonly text: string,
  ) {
    super(`MCP tool "${tool}" error: ${text.trim()}`);
    this.name = "MCPToolError";
  }
}

/** Reads the text/structured/isError fields off a CallTool result union shape. */
function splitCallToolResult(res: unknown): MCPCallOutcome {
  const r = (res ?? {}) as {
    content?: unknown;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text"
      ) {
        parts.push(String((block as { text?: unknown }).text ?? ""));
      }
      // Non-text content (image/audio/resource/resource_link) is ignored in v1;
      // consumers needing it must read structured content via a parseResponse hook.
    }
  }
  const outcome: MCPCallOutcome = {
    text: parts.join("\n"),
    isToolError: r.isError === true,
  };
  if (r.structuredContent !== undefined) outcome.structured = r.structuredContent;
  return outcome;
}

/** {@link MCPSession} backed by a connected SDK {@link Client}. */
export class RealMCPSession implements MCPSession {
  constructor(private readonly client: Client) {}

  async callTool(
    name: string,
    args: Record<string, unknown>,
    callTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<MCPCallOutcome> {
    const options: RequestOptions = {};
    if (signal) options.signal = signal;
    if (callTimeoutMs > 0) options.timeout = callTimeoutMs;
    const res = await this.client.callTool({ name, arguments: args }, undefined, options);
    return splitCallToolResult(res);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * Applies each `KEY=VALUE` header to `target`, but only when the header is not
 * already present — so the SDK can still set protocol headers (e.g.
 * Mcp-Session-Id) without the static auth layer stomping on them. Mirrors Go's
 * `headerInjectingTransport.RoundTrip`. Exported for direct unit testing.
 */
export function applyStaticHeaders(target: Headers, headers: string[]): Headers {
  for (const h of headers) {
    const idx = h.indexOf("=");
    if (idx <= 0) continue;
    const key = h.slice(0, idx).trim();
    const value = h.slice(idx + 1).trim();
    if (!target.has(key)) target.set(key, value);
  }
  return target;
}

/** A `fetch` that injects the configured static headers on every request. */
function headerInjectingFetch(headers: string[]): FetchLike {
  return (url, init) => {
    const merged = applyStaticHeaders(new Headers(init?.headers), headers);
    return fetch(url, { ...init, headers: merged });
  };
}

/** Builds the SDK transport implied by the spec. */
export function buildTransport(spec: MCPTransportSpec): Transport {
  if (spec.kind === "stdio") {
    // The SDK defaults env to a safe subset (getDefaultEnvironment); when the
    // spec adds vars, merge them on top of that subset so configured values are
    // present without dropping the safe defaults. Go appended to os.Environ();
    // this is the idiomatic, safer SDK equivalent.
    const extras = kvArrayToRecord(spec.env);
    const hasExtras = Object.keys(extras).length > 0;
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      ...(hasExtras ? { env: { ...getDefaultEnvironment(), ...extras } } : {}),
    });
  }
  const opts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};
  if (spec.headers.length > 0) opts.fetch = headerInjectingFetch(spec.headers);
  return new StreamableHTTPClientTransport(new URL(spec.url), opts);
}

function kvArrayToRecord(kv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of kv) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Builds the transport described by `spec` and connects an MCP client over it.
 * `initTimeoutMs <= 0` means no handshake timeout. Mirrors Go's
 * startMCPSessionFromSpec, including the `connect <label>: <err>` wrap.
 */
export async function startMCPSessionFromSpec(
  spec: MCPTransportSpec,
  initTimeoutMs: number,
  signal?: AbortSignal,
): Promise<MCPSession> {
  const transport = buildTransport(spec);
  const client = new Client({ name: "sparsi-ts", version: "0.0.0" });
  const options: RequestOptions = {};
  if (signal) options.signal = signal;
  if (initTimeoutMs > 0) options.timeout = initTimeoutMs;
  try {
    await client.connect(transport, options);
  } catch (err) {
    throw new Error(
      `connect ${mcpLabel(spec)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return new RealMCPSession(client);
}

/** Constructs an {@link MCPSession} from a spec. The seam tests override. */
export type MCPSessionFactory = (
  spec: MCPTransportSpec,
  initTimeoutMs: number,
  signal?: AbortSignal,
) => Promise<MCPSession>;

let activeFactory: MCPSessionFactory = startMCPSessionFromSpec;

/**
 * Constructs a session via the active factory. The pool and both ops go through
 * this indirection so a test-installed factory drives all session creation.
 */
export function createMCPSession(
  spec: MCPTransportSpec,
  initTimeoutMs: number,
  signal?: AbortSignal,
): Promise<MCPSession> {
  return activeFactory(spec, initTimeoutMs, signal);
}

/** Overrides the session factory (test support — inject fakes/in-memory sessions). */
export function setMCPSessionFactory(factory: MCPSessionFactory): void {
  activeFactory = factory;
}

/** Restores the default SDK-backed session factory (test support). */
export function resetMCPSessionFactory(): void {
  activeFactory = startMCPSessionFromSpec;
}
