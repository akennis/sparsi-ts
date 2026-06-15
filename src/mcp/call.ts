/**
 * MCPCallOp: invoke a single MCP server tool as a DAG step.
 *
 * Expressed as a typed higher-order function. The result type is selected by an
 * explicit `output` discriminator (reusing the AI compute OutputKind, plus
 * "json") with an optional `parseResponse` hook for full control, and arguments
 * are marshaled via the optional `formatArgs` hook. Each run opens a fresh
 * session (unless pooled), encodes args (nil → {}), retries transient errors with
 * exponential backoff (500ms → cap 30s, default 3 retries, abort-aware), fails
 * tool-errors immediately (no retry), and prefers structured content for
 * object-shaped outputs.
 */

import { parseResult, type OutputKind } from "../ai/compute";
import { acquireMCPSession, prewarmMCPPool } from "./pool";
import { resolveMCPConfig, type MCPConnectionOptions, type MCPResolvedConfig } from "./transport";
import type { MCPCallOutcome } from "./client";
import { errMsg } from "../internal/error";
import { warn } from "../internal/warn";
import { abortError, sleepOrAbort } from "./util";

/** Description for the catalog (`## MCP` section). */
export const MCPCallOpDescription = `MCPCallOp: invoke a single MCP server tool as a DAG step.
Each run opens a fresh session, completes the MCP handshake, calls the tool, and tears the
session down — unless poolSize > 0 opts into the warm-replenish pool (stdio only).
  Options:  transport       — "stdio" (default) or "http". Selects how the MCP server is reached.
            stdio options:
              command         — server executable (e.g. "npx", "uvx", "/abs/path"). Required.
              args            — string[] of CLI args. Optional.
              env             — Record<string, string> of extra environment variables. Optional.
            http options:
              url             — full endpoint URL (http or https). Required.
              headers         — Record<string, string> injected into every request
                                (e.g. { Authorization: "Bearer \${TOKEN}" }). Optional.
            tool            — MCP tool to invoke. Required.
            initTimeoutMs   — handshake timeout in ms (default 10000).
            callTimeoutMs   — single tool call timeout in ms (default 30000).
            maxRetries      — transient-error retries (default 3).
            poolSize        — warm-replenish pool target capacity per session-spec key
                              (default 0, no pool). Only supported for transport "stdio".
                              Pair with shutdownMCPPool at process exit so pre-started
                              subprocesses drain.
            poolPrewarm     — when poolSize > 0, fill the pool during setup (default true).
            output          — built-in result dispatch: "string" (default), "number", "boolean",
                              "string[]", "number[]", "map", or "json" (decodes structured content,
                              preferred, or parses the text as JSON).
            formatArgs      — hook to marshal the input into the tool's "arguments" object.
            parseResponse   — hook for full control of parsing (receives text + structured).
  Input:    input — marshaled as the tool's "arguments" object (passed as-is unless formatArgs is set).
  Output:   the parsed tool result, typed by the chosen output kind or parseResponse hook.`;

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
   * Full control over parsing. Receives the concatenated text and the raw
   * structured object (undefined if none) and returns the typed result; skips the
   * built-in dispatch entirely.
   */
  parseResponse?: (text: string, structured: unknown) => Out;
  /**
   * Controls how `input` is marshaled into the tool's "arguments" object. If
   * unset, a non-null `input` is passed as-is.
   */
  formatArgs?: (input: In) => Record<string, unknown>;
}

/** Resolves the shared config + tool name and validates them (no side effects). */
function resolveCallConfig<In, Out>(
  opts: MCPCallOptions<In, Out>,
): { cfg: MCPResolvedConfig; tool: string } {
  const cfg = resolveMCPConfig(opts, "MCPCallOp");
  const tool = (opts.tool ?? "").trim();
  if (tool === "") throw new Error("MCPCallOp: 'tool' param is required");
  return { cfg, tool };
}

/**
 * Validates options, resolves the shared config + tool name, and prewarms the
 * pool exactly once (the setup step). Call this once at workflow-build time;
 * {@link mcpCall} (the per-run path) never prewarms.
 */
export function setupMCPCall<In, Out>(
  opts: MCPCallOptions<In, Out>,
): { cfg: MCPResolvedConfig; tool: string } {
  const resolved = resolveCallConfig(opts);
  if (resolved.cfg.poolSize > 0 && resolved.cfg.poolPrewarm) {
    prewarmMCPPool(resolved.cfg.spec, resolved.cfg.initTimeoutMs, resolved.cfg.poolSize);
  }
  return resolved;
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

/**
 * Coerces already-decoded structured content into the target kind using JSON
 * (not text) semantics. Returns `undefined` when the structured shape doesn't fit
 * the kind, so the caller falls back to text parsing.
 */
function coerceStructured(kind: MCPOutputKind, v: unknown): { value: unknown } | undefined {
  const isFiniteNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  switch (kind) {
    case "json":
      // "json" has no fixed target shape to validate against, so any structured
      // content fits: when present it is always used and never falls through to
      // text parsing. (The scalar/collection kinds below DO fall through, via an
      // `undefined` return, when the structured shape doesn't match.)
      return { value: v };
    case "string":
      return typeof v === "string" ? { value: v } : undefined;
    case "number":
      return isFiniteNum(v) ? { value: v } : undefined;
    case "boolean":
      return typeof v === "boolean" ? { value: v } : undefined;
    case "string[]":
      return Array.isArray(v) && v.every((e) => typeof e === "string") ? { value: v } : undefined;
    case "number[]":
      return Array.isArray(v) && v.every(isFiniteNum) ? { value: v } : undefined;
    case "map":
      return typeof v === "object" && v !== null && !Array.isArray(v) && allStringValues(v as Record<string, unknown>)
        ? { value: v }
        : undefined;
    default:
      return undefined;
  }
}

/** Decodes a tool outcome into the typed result via the configured dispatch. */
function decodeResult<In, Out>(outcome: MCPCallOutcome, opts: MCPCallOptions<In, Out>): Out {
  if (opts.parseResponse) return opts.parseResponse(outcome.text, outcome.structured);
  const kind: MCPOutputKind = opts.output ?? "string";

  // Try structured content first for EVERY output kind: JSON-coerce it into the
  // target shape and use it on success, falling back to text parsing only when the
  // structured shape doesn't fit.
  if (outcome.structured !== undefined) {
    const coerced = coerceStructured(kind, outcome.structured);
    if (coerced) return coerced.value as Out;
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
      warn(`MCPCallOp.close_warn: ${errMsg(e)}`);
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
  // Per-run path: resolve config but never prewarm — prewarm is a one-time setup
  // concern (see setupMCPCall). The pool still tops up lazily on acquire, so direct
  // mcpCall users remain correct without an explicit setup.
  const { cfg, tool } = resolveCallConfig(opts);
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
      warn(
        `MCPCallOp.attempt_failed (attempt ${attempt + 1} of ${cfg.maxRetries + 1}): ${errMsg(err)}`,
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
