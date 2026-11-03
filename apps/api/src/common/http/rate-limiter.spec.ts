import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  it('allows up to the limit, refuses the next with a retry hint, and resets after the window', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(3, 60_000, () => now);
    limiter.hit('a');
    limiter.hit('a');
    limiter.hit('a');
    let refused: unknown;
    try {
      limiter.hit('a');
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).status).toBe(429);
    expect((refused as AppError).extensions?.retryAfter).toBe(60);
    // Another key is unaffected.
    expect(() => limiter.hit('b')).not.toThrow();
    now += 60_001;
    expect(() => limiter.hit('a')).not.toThrow();
  });
});
