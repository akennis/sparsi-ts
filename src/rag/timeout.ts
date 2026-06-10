/**
 * Deadline plumbing for the RAG ops.
 *
 * Per-op deadlines are modeled with an {@link AbortSignal}-based deadline
 * ({@link withDeadline}) and a sentinel error ({@link DeadlineExceededError})
 * detected by walking the `.cause` chain ({@link isDeadlineExceeded}).
 */

/** The reason an aborted signal carries when a {@link withDeadline} deadline fires. */
export class DeadlineExceededError extends Error {
  constructor(message = "context deadline exceeded") {
    super(message);
    this.name = "DeadlineExceededError";
  }
}

/**
 * Reports whether `err` (or anything in its `.cause` chain) is a
 * {@link DeadlineExceededError}.
 */
export function isDeadlineExceeded(err: unknown): boolean {
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur != null && !seen.has(cur)) {
    if (cur instanceof DeadlineExceededError) return true;
    seen.add(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Runs `fn` under a deadline. `fn` receives a signal that aborts when `timeoutMs`
 * elapses (with a {@link DeadlineExceededError} reason) or when `parent` aborts
 * (propagating `parent.reason`).
 *
 * A non-positive `timeoutMs` imposes no deadline: `fn` receives `parent`
 * unchanged (or a never-aborting signal when `parent` is absent), so "0" means
 * "honor only the ambient signal".
 */
export async function withDeadline<T>(
  timeoutMs: number,
  parent: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!(timeoutMs > 0)) {
    return fn(parent ?? new AbortController().signal);
  }
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent!.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new DeadlineExceededError()), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener("abort", onParentAbort);
  }
}
