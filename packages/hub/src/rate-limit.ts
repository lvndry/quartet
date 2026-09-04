/**
 * @fileoverview How often one caller may do something expensive.
 *
 * Used for handle claims and for the frame allowance on each socket. A token bucket rather
 * than a fixed window, because a fixed window lets a caller spend the next window's whole
 * allowance the instant it opens. The clock is injected so the rules are testable.
 */

/** One caller's allowance: `burst` at once, then one more every `refillMs`. */
export interface RateLimit {
  readonly burst: number;
  readonly refillMs: number;
}

export type Verdict =
  | { readonly allowed: true }
  /** How long until one token exists, so the answer can carry a `Retry-After`. */
  | { readonly allowed: false; readonly retryAfterMs: number };

/**
 * When to bother sweeping idle callers.
 *
 * Buckets are dropped only once fully refilled, so sweeping cannot hand anybody back an
 * allowance they had spent.
 */
const SWEEP_ABOVE = 1_000;

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number = Date.now,
  ) {}

  /** Spend one token if there is one. The only method that mutates anything. */
  take(key: string): Verdict {
    const at = this.now();
    const tokens = this.tokensAt(key, at);

    if (tokens < 1) {
      this.buckets.set(key, { tokens, at });
      return { allowed: false, retryAfterMs: Math.ceil((1 - tokens) * this.limit.refillMs) };
    }

    this.buckets.set(key, { tokens: tokens - 1, at });
    if (this.buckets.size > SWEEP_ABOVE) this.sweep(at);
    return { allowed: true };
  }

  private tokensAt(key: string, at: number): number {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return this.limit.burst;
    const restored = (at - bucket.at) / this.limit.refillMs;
    return Math.min(this.limit.burst, bucket.tokens + restored);
  }

  private sweep(at: number): void {
    for (const [key] of this.buckets) {
      if (this.tokensAt(key, at) >= this.limit.burst) this.buckets.delete(key);
    }
  }
}
