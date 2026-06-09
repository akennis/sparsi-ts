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
