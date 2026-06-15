import type { AIClient, Logger, RunContext } from "./types";

export interface ContextInit {
  signal: AbortSignal;
  values: ReadonlyMap<string, unknown>;
  ai?: AIClient;
  logger?: Logger;
  reasoning: boolean;
}

/** Builds the immutable per-run context handed to every op. */
export function makeContext(init: ContextInit): RunContext {
  return {
    signal: init.signal,
    ai: init.ai,
    logger: init.logger,
    reasoning: init.reasoning,
    value<T = unknown>(key: string): T | undefined {
      return init.values.get(key) as T | undefined;
    },
  };
}

/**
 * Derives a context that runs an op under a different AI client, preserving
 * every other field (signal, values, logger, reasoning). This is the single,
 * library-owned place per-op client overrides happen, so user code never
 * reconstructs {@link RunContext} by hand to redirect `ctx.ai`.
 */
export function withAI(ctx: RunContext, ai: AIClient): RunContext {
  return { ...ctx, ai };
}
