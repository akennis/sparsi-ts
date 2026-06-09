/**
 * MCPCallOp: invoke a single MCP server tool as a DAG step.
 *
 * Faithful port of sparsi-go's mcp_call_op.go, expressed as a typed
 * higher-order function rather than Go's reflection-based IOperator. Go's
 * compile-time `Out` type drives a `parseResultText` type switch; sparsi-ts
 * replaces that reflection with an explicit `output` discriminator (reusing the
 * AI compute OutputKind, plus "json") and an optional `parseResponse` hook (the
 * MCPResponseParser analog). `MCPArgsFormatter` becomes the optional `formatArgs`
 * hook. Behavior is preserved: fresh session per run (unless pooled), encodeArgs
 * (nil → {}), transient-error retry with exponential backoff (500ms → cap 30s,
 * default 3 retries, abort-aware), tool-errors fail immediately (no retry),
 * structured content preferred for object-shaped outputs, and all error wording.
 */

import { parseResult, type OutputKind } from "../ai/compute";
import { acquireMCPSession, prewarmMCPPool } from "./pool";
import { resolveMCPConfig, type MCPConnectionOptions, type MCPResolvedConfig } from "./transport";
import type { MCPCallOutcome } from "./client";
import { abortError, errMsg, sleepOrAbort } from "./util";

/** Verbatim Go description for the catalog (`## MCP` section). */
export const MCPCallOpDescription = `MCPCallOp: invoke a single MCP server tool as a DAG step.
Each Run opens a fresh session, completes the MCP handshake, calls the tool, and tears the
session down — unless pool_size > 0 opts into the warm-replenish pool (stdio only in v1).
  Params:   transport       — "stdio" (default) or "http". Selects how the MCP server is reached.
            stdio params:
              command         — server executable (e.g. "npx", "uvx", "/abs/path"). Required.
              args            — comma-separated CLI args. Optional.
              env             — comma-separated KEY=VALUE pairs. Optional.
            http params:
              url             — full endpoint URL (http or https). Required.
              headers         — comma-separated KEY=VALUE pairs injected into every request
                                (e.g. "Authorization=Bearer \${TOKEN}"). Optional.
            tool_name       — MCP tool to invoke. Required.
            init_timeout_ms — handshake timeout in ms (default "10000").
            call_timeout_ms — single tool call timeout in ms (default "30000").
            max_retries     — transient-error retries (default "3").
            pool_size       — warm-replenish pool target capacity per session-spec key
                              (default "0", no pool). Only supported for transport="stdio".
                              Pair with library.ShutdownMCPPool from main() so pre-started
                              subprocesses drain at exit.
            pool_prewarm    — when pool_size > 0, fill the pool during Setup (default "true").
  Inputs:   Input *In       — JSON-marshaled as the tool's "arguments" object. Implement
                              library.MCPArgsFormatter on *In to control marshaling.
  Outputs:  Result Out      — default dispatch handles string, float64, int, bool,
                              []string, []float64, []int, map[string]string, and any
                              struct decodable via json.Unmarshal (structured content
                              preferred when the server emits it). Implement
                              library.MCPResponseParser on *Out to fully control parsing.
Concrete variants embed library.MCPCallOp[In, Out] in a named struct and register via
operator.RegisterOp[ConcreteOp]() — never register the generic MCPCallOp directly.`;

/** Built-in output dispatch kinds for MCP results ("json" decodes structured/JSON). */
export type MCPOutputKind = OutputKind | "json";

export interface MCPCallOptions<In, Out> extends MCPConnectionOptions {
  /** MCP tool to invoke. Required. */
  tool: string;
  /**
   * Built-in result dispatch. Default "string". Scalar/collection kinds parse the
   * tool's text content; "json" decodes structured content (preferred) or parses
   * the text as JSON. Ignored when {@link parseResponse} is set.
   */
  output?: MCPOutputKind;
  /**
   * Full control over parsing (the MCPResponseParser analog). Receives the
   * concatenated text and the raw structured object (undefined if none) and
   * returns the typed result; skips the built-in dispatch entirely.
   */
  parseResponse?: (text: string, structured: Record<string, unknown> | undefined) => Out;
  /**
   * Controls how `input` is marshaled into the tool's "arguments" object (the
   * MCPArgsFormatter analog). If unset, a non-null `input` is passed as-is.
   */
  formatArgs?: (input: In) => Record<string, unknown>;
}

/** Validates options and resolves the shared config + tool name (the Setup analog). */
export function setupMCPCall<In, Out>(
  opts: MCPCallOptions<In, Out>,
): { cfg: MCPResolvedConfig; tool: string } {
  const cfg = resolveMCPConfig(opts, "MCPCallOp");
  const tool = (opts.tool ?? "").trim();
  if (tool === "") throw new Error("MCPCallOp: 'tool' param is required");
  return { cfg, tool };
}

function encodeArgs<In, Out>(
  input: In | null | undefined,
  opts: MCPCallOptions<In, Out>,
): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  if (opts.formatArgs) return opts.formatArgs(input);
  return input as Record<string, unknown>;
}

function allStringValues(o: Record<string, unknown>): boolean {
  return Object.values(o).every((v) => typeof v === "string");
}

/** Decodes a tool outcome into the typed result via the configured dispatch. */
function decodeResult<In, Out>(outcome: MCPCallOutcome, opts: MCPCallOptions<In, Out>): Out {
  if (opts.parseResponse) return opts.parseResponse(outcome.text, outcome.structured);
  const kind: MCPOutputKind = opts.output ?? "string";

  // Structured content is preferred only for object-shaped outputs — mirroring
  // Go, where json.Unmarshal of a structured object into a scalar/array fails and
  // falls through to the text path.
  if (outcome.structured !== undefined) {
    if (kind === "json") return outcome.structured as Out;
    if (kind === "map" && allStringValues(outcome.structured)) return outcome.structured as Out;
  }

  if (kind === "json") {
    const s = outcome.text.trim();
    try {
      return JSON.parse(s) as Out;
    } catch (e) {
      throw new Error(`MCPCallOp: expected JSON, got "${s}": ${errMsg(e)}`);
    }
  }
  return parseResult(kind, outcome.text) as Out;
}

/** Acquires a session, calls the tool, and tears the session down. */
async function runOnce<In, Out>(
  cfg: MCPResolvedConfig,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<MCPCallOutcome> {
  const sess = await acquireMCPSession(cfg.spec, cfg.initTimeoutMs, cfg.poolSize, signal);
  try {
    return await sess.callTool(tool, args, cfg.callTimeoutMs, signal);
  } finally {
    try {
      await sess.close();
    } catch (e) {
      console.warn(`MCPCallOp.close_warn: ${errMsg(e)}`);
    }
  }
}

/**
 * Invokes a single MCP server tool. By default each call opens a fresh session,
 * completes the handshake, calls the tool, and tears the session down; set
 * `poolSize > 0` (stdio only) to borrow a pre-warmed session instead. Transient
 * transport failures retry with exponential backoff; a tool-level error fails
 * immediately (no retry).
 */
export async function mcpCall<In, Out>(
  input: In | null | undefined,
  opts: MCPCallOptions<In, Out>,
  ctx: { signal?: AbortSignal } = {},
): Promise<Out> {
  const { cfg, tool } = setupMCPCall(opts);
  if (cfg.poolSize > 0 && cfg.poolPrewarm) {
    prewarmMCPPool(cfg.spec, cfg.initTimeoutMs, cfg.poolSize);
  }
  const args = encodeArgs(input, opts);
  const signal = ctx.signal;

  let delay = 500;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (attempt > 0) {
      const { aborted } = await sleepOrAbort(delay, signal);
      if (aborted) throw abortError(signal);
      delay = Math.min(delay * 2, 30_000);
    }

    let outcome: MCPCallOutcome;
    try {
      outcome = await runOnce(cfg, tool, args, signal);
    } catch (err) {
      lastErr = err;
      console.warn(
        `MCPCallOp.attempt_failed (attempt ${attempt + 1} of ${cfg.maxRetries}): ${errMsg(err)}`,
      );
      continue;
    }
    if (outcome.isToolError) {
      throw new Error(`MCPCallOp: tool "${tool}" reported error: ${outcome.text.trim()}`);
    }
    return decodeResult(outcome, opts);
  }
  throw new Error(
    `MCPCallOp: all ${cfg.maxRetries + 1} attempts failed; last error: ${errMsg(lastErr)}`,
  );
}
