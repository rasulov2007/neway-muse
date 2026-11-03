import { AppError } from '../errors/app-error';

/**
 * A fixed-window, in-memory rate limiter for the few routes anybody on the internet can call.
 *
 * In memory on purpose: it is the first, cheap line, and it runs before validation and before the
 * database is touched. It is per process, so the public application also enforces durable limits
 * in the database (per hashed address and per phone number), which hold across restarts and
 * instances. Buckets are swept as they expire, so the map cannot grow without bound.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit against `key`; throws 429 with `retryAfter` (seconds) once over the limit. */
  hit(key: string, detail = 'Too many requests. Please wait a moment and try again.'): void {
    const now = this.now();
    this.sweep(now);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    bucket.count += 1;
    if (bucket.count > this.limit) {
      throw new AppError({
        status: 429,
        title: 'Too Many Requests',
        detail,
        extensions: { retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) },
      });
    }
  }

  /**
   * Refuses `key` with 429 when it is already at the limit, without counting this request. For a
   * limit counted somewhere else (failed lookups) that must still close every door once reached.
   */
  check(key: string, detail = 'Too many requests. Please wait a moment and try again.'): void {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt > now && bucket.count >= this.limit) {
      throw new AppError({
        status: 429,
        title: 'Too Many Requests',
        detail,
        extensions: { retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) },
      });
    }
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
