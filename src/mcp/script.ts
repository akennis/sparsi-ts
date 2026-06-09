/**
 * MCPScriptOp: orchestrate a sequence of MCP tool calls against one long-lived
 * MCP session.
 *
 * Faithful port of sparsi-go's mcp_script_op.go, expressed as a typed
 * higher-order function. Go's `Script func(ctx, sess, in, out *Out) error`
 * (populate-out-pointer, return-error) becomes a callback that RETURNS the typed
 * result. Go's `mcpSessionAdapter` (applies the per-call timeout and surfaces
 * MCPToolError on isError) becomes {@link MCPScriptSession}. Behavior is
 * preserved: the Script runs exactly once per Run; only session-START failures
 * retry (bounded backoff, abort-aware); the session is torn down when Script
 * returns; tool-level errors surface as {@link MCPToolError}.
 */

import { MCPToolError, type MCPCallOutcome, type MCPSession } from "./client";
import { acquireMCPSession, prewarmMCPPool } from "./pool";
import { resolveMCPConfig, type MCPConnectionOptions, type MCPResolvedConfig } from "./transport";
import { abortError, errMsg, sleepOrAbort } from "./util";

/** Verbatim Go description for the catalog (`## MCP` section). */
export const MCPScriptOpDescription = `MCPScriptOp: orchestrate a sequence of MCP tool calls against a single,
long-lived MCP session. Use this when one DAG step needs multiple tool calls
that share server-side state (browser session, file handles, etc.). The
user-supplied Script callback runs exactly once per Run, receives a
MCPSession, and is free to invoke CallTool any number of times in any order.
  Params:   transport       — "stdio" (default) or "http". Selects how the MCP server is reached.
            stdio params:
              command         — server executable (e.g. "npx", "uvx", "/abs/path"). Required.
              args            — comma-separated CLI args (e.g. "-y,@playwright/mcp@latest"). Optional.
              env             — comma-separated KEY=VALUE pairs. Optional.
            http params:
              url             — full endpoint URL (http or https). Required.
              headers         — comma-separated KEY=VALUE pairs injected into every request
                                (e.g. "Authorization=Bearer \${TOKEN}"). Optional.
            init_timeout_ms — handshake timeout in ms (default "10000").
            call_timeout_ms — per-tool-call timeout in ms (default "30000").
            max_retries     — retries for session-start failures only; the Script runs at most
                              once per Run (default "3").
            pool_size       — warm-replenish pool target capacity per session-spec key
                              (default "0", no pool). Vertices with the same spec share warm
                              slots; each Run gets a fresh session — sessions are never reused
                              for a second Run. Only supported for transport="stdio" in v1.
                              Pair with library.ShutdownMCPPool from main() so pre-started
                              subprocesses drain at exit.
            pool_prewarm    — when pool_size > 0, fill the pool during Setup (default "true");
                              set "false" to fill lazily on first Run.
  Inputs:   Input *In       — typed input handed to Script.
  Outputs:  Result Out      — populated by Script.
Concrete variants embed library.MCPScriptOp[In, Out] in a named struct and
register via operator.RegisterOpFactory(name, factory), with the Script field
assigned in the factory closure.`;

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

/** Validates options and resolves the shared config (the Setup analog). */
export function setupMCPScript<In, Out>(
  opts: MCPScriptOptions<In, Out>,
): { cfg: MCPResolvedConfig } {
  const cfg = resolveMCPConfig(opts, "MCPScriptOp");
  if (typeof opts.script !== "function") {
    throw new Error("MCPScriptOp: Script callback is nil — provide opts.script");
  }
  return { cfg };
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
  const { cfg } = setupMCPScript(opts);
  if (cfg.poolSize > 0 && cfg.poolPrewarm) {
    prewarmMCPPool(cfg.spec, cfg.initTimeoutMs, cfg.poolSize);
  }
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
      console.warn(
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
        console.warn(`MCPScriptOp.close_warn: ${errMsg(e)}`);
      }
    }
  }
  throw new Error(
    `MCPScriptOp: all ${cfg.maxRetries + 1} session-start attempts failed; last error: ${errMsg(lastStartErr)}`,
  );
}
