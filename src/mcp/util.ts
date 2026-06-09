/** Small shared helpers for the MCP ops (backoff sleep + error formatting). */

/**
 * Resolves after `ms`, or immediately when `signal` aborts. Never rejects — the
 * caller inspects `aborted` to decide whether to stop (the idiomatic equivalent
 * of Go's `select { case <-ctx.Done(): ...; case <-time.After(d): }`).
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

/** Extracts a message from an unknown thrown value. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Builds the error to throw when a run is aborted (mirrors Go's ctx.Err()). */
export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "aborted");
}
