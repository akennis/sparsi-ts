/**
 * MCPScriptOp: orchestrate a sequence of MCP tool calls against one long-lived
 * MCP session.
 *
 * Expressed as a typed higher-order function: the Script callback RETURNS the
 * typed result. {@link MCPScriptSession} applies the per-call timeout and surfaces
 * {@link MCPToolError} on isError. The Script runs exactly once per run; only
 * session-START failures retry (bounded backoff, abort-aware); the session is torn
 * down when Script returns; tool-level errors surface as {@link MCPToolError}.
 */

import { MCPToolError, type MCPCallOutcome, type MCPSession } from "./client";
import { acquireMCPSession, prewarmMCPPool } from "./pool";
import { resolveMCPConfig, type MCPConnectionOptions, type MCPResolvedConfig } from "./transport";
import { errMsg } from "../internal/error";
import { warn } from "../internal/warn";
import { abortError, sleepOrAbort } from "./util";

/** Description for the catalog (`## MCP` section). */
export const MCPScriptOpDescription = `MCPScriptOp: orchestrate a sequence of MCP tool calls against a single,
long-lived MCP session. Use this when one DAG step needs multiple tool calls
that share server-side state (browser session, file handles, etc.). The
user-supplied Script callback runs exactly once per run, receives a session, and
is free to invoke callTool any number of times in any order.
  Options:  transport       — "stdio" (default) or "http". Selects how the MCP server is reached.
            stdio options:
              command         — server executable (e.g. "npx", "uvx", "/abs/path"). Required.
              args            — string[] of CLI args (e.g. ["-y", "@playwright/mcp@latest"]). Optional.
              env             — Record<string, string> of extra environment variables. Optional.
            http options:
              url             — full endpoint URL (http or https). Required.
              headers         — Record<string, string> injected into every request
                                (e.g. { Authorization: "Bearer \${TOKEN}" }). Optional.
            initTimeoutMs   — handshake timeout in ms (default 10000).
            callTimeoutMs   — per-tool-call timeout in ms (default 30000).
            maxRetries      — retries for session-start failures only; the Script runs at most
                              once per run (default 3).
            poolSize        — warm-replenish pool target capacity per session-spec key
                              (default 0, no pool). Vertices with the same spec share warm
                              slots; each run gets a fresh session — sessions are never reused
                              for a second run. Only supported for transport "stdio".
                              Pair with shutdownMCPPool at process exit so pre-started
                              subprocesses drain.
            poolPrewarm     — when poolSize > 0, fill the pool during setup (default true);
                              set false to fill lazily on first run.
  Input:    input           — typed input handed to Script.
  Output:   the typed value returned by Script.`;

/**
 * The per-Run session handed to a Script. Each {@link callTool} reuses the same
 * underlying session, so server-side state persists across calls. A tool-level
 * error (isError=true) is thrown as {@link MCPToolError}; scripts can
 * `instanceof`-check it to recover from anticipated failures.
 */
export interface MCPScriptSession {
  callTool(name: string, args: Record<string, unknown>): Promise<MCPCallOutcome>;
}

/** The user callback: runs once per Run, returns the typed result. */
export type MCPScriptCallback<In, Out> = (
  session: MCPScriptSession,
  input: In | null | undefined,
  ctx: { signal?: AbortSignal },
) => Out | Promise<Out>;

export interface MCPScriptOptions<In, Out> extends MCPConnectionOptions {
  /** Invoked exactly once per Run after the session opens. Required. */
  script: MCPScriptCallback<In, Out>;
}

/** Resolves the shared config and validates the script callback (no side effects). */
function resolveScriptConfig<In, Out>(
  opts: MCPScriptOptions<In, Out>,
): { cfg: MCPResolvedConfig } {
  const cfg = resolveMCPConfig(opts, "MCPScriptOp");
  if (typeof opts.script !== "function") {
    throw new Error("MCPScriptOp: Script callback is nil — provide opts.script");
  }
  return { cfg };
}

/**
 * Validates options, resolves the shared config, and prewarms the pool exactly
 * once (the setup step). Call this once at workflow-build time; {@link mcpScript}
 * (the per-run path) never prewarms.
 */
export function setupMCPScript<In, Out>(
  opts: MCPScriptOptions<In, Out>,
): { cfg: MCPResolvedConfig } {
  const resolved = resolveScriptConfig(opts);
  if (resolved.cfg.poolSize > 0 && resolved.cfg.poolPrewarm) {
    prewarmMCPPool(resolved.cfg.spec, resolved.cfg.initTimeoutMs, resolved.cfg.poolSize);
  }
  return resolved;
}

/** Wraps a raw session with the per-call timeout + MCPToolError surfacing. */
function makeAdapter(
  sess: MCPSession,
  callTimeoutMs: number,
  signal: AbortSignal | undefined,
): MCPScriptSession {
  return {
    async callTool(name, args) {
      const outcome = await sess.callTool(name, args, callTimeoutMs, signal);
      if (outcome.isToolError) throw new MCPToolError(name, outcome.text);
      return outcome;
    },
  };
}

/**
 * Owns one MCP session for the duration of a single Run, hands a
 * {@link MCPScriptSession} to `opts.script`, and tears the session down when the
 * script returns. Unlike {@link mcpCall}, the script is NOT retried — only
 * session-start failures retry (up to maxRetries).
 */
export async function mcpScript<In, Out>(
  input: In | null | undefined,
  opts: MCPScriptOptions<In, Out>,
  ctx: { signal?: AbortSignal } = {},
): Promise<Out> {
  // Per-run path: resolve config but never prewarm — prewarm is a one-time setup
  // concern (see setupMCPScript). The pool tops up lazily on acquire.
  const { cfg } = resolveScriptConfig(opts);
  const signal = ctx.signal;

  let delay = 500;
  let lastStartErr: unknown;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (attempt > 0) {
      const { aborted } = await sleepOrAbort(delay, signal);
      if (aborted) throw abortError(signal);
      delay = Math.min(delay * 2, 30_000);
    }

    let sess: MCPSession;
    try {
      sess = await acquireMCPSession(cfg.spec, cfg.initTimeoutMs, cfg.poolSize, signal);
    } catch (err) {
      lastStartErr = err;
      warn(
        `MCPScriptOp.start_failed (attempt ${attempt + 1} of ${cfg.maxRetries + 1}): ${errMsg(err)}`,
      );
      continue;
    }

    // Session is open: run the Script exactly once, then tear down. The script's
    // own error (if any) propagates — it is never retried.
    const adapter = makeAdapter(sess, cfg.callTimeoutMs, signal);
    try {
      return await opts.script(adapter, input, { signal });
    } finally {
      try {
        await sess.close();
      } catch (e) {
        warn(`MCPScriptOp.close_warn: ${errMsg(e)}`);
      }
    }
  }
  throw new Error(
    `MCPScriptOp: all ${cfg.maxRetries + 1} session-start attempts failed; last error: ${errMsg(lastStartErr)}`,
  );
}
