/**
 * A counting semaphore bounding how many ops run concurrently. A limit of 0 or
 * less means unbounded (every acquire resolves immediately).
 */
export class Pool {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  private readonly unbounded: boolean;

  constructor(limit: number) {
    this.unbounded = !Number.isFinite(limit) || limit <= 0;
    this.available = this.unbounded ? Number.POSITIVE_INFINITY : limit;
  }

  /** Runs `fn` once a slot is free, releasing the slot when it settles. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.unbounded) return fn();
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}
