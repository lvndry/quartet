/**
 * @fileoverview How often one caller may do something expensive.
 *
 * Exists for `POST /agents`, which mints an identity and takes a handle out of a namespace
 * everybody shares. It cost nothing to call and proved nothing, so one script could claim
 * every readable handle on a hub before anybody noticed — the squatting half of the
 * impersonation gap, and the half that does not need an identity story to fix.
 *
 * A token bucket rather than a fixed window, because a fixed window lets a caller spend the
 * next window's whole allowance the instant it opens. The clock is a constructor argument so
 * the rules can be tested without waiting for real time to pass.
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
 * Buckets are only dropped once they have refilled completely, so sweeping can never hand
 * anybody back an allowance they had already spent. Until the map is large enough to matter,
 * walking it on every call would cost more than the memory it saves.
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
