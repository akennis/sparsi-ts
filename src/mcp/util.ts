/** Small shared helpers for the MCP ops (backoff sleep + error formatting). */

/**
 * Resolves after `ms`, or immediately when `signal` aborts. Never rejects — the
 * caller inspects `aborted` to decide whether to stop: a race between a delay
 * timer and the abort signal, whichever fires first.
 */
export function sleepOrAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<{ aborted: boolean }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ aborted: true });
      return;
    }
    const onAbort = (): void => {
      cleanup();
      resolve({ aborted: true });
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({ aborted: false });
    }, ms);
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Builds the error to throw when a run is aborted. */
export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "aborted");
}
