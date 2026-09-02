import { describe, expect, it } from "bun:test";
import { RateLimiter } from "./rate-limit";

/** A clock the test moves by hand, so none of this waits on real time. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000_000;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("a caller's allowance", () => {
  it("lets the burst through and then refuses", () => {
    const time = clock();
    const limiter = new RateLimiter({ burst: 3, refillMs: 60_000 }, time.now);

    expect(limiter.take("1.2.3.4").allowed).toBe(true);
    expect(limiter.take("1.2.3.4").allowed).toBe(true);
    expect(limiter.take("1.2.3.4").allowed).toBe(true);
    expect(limiter.take("1.2.3.4").allowed).toBe(false);
  });

  it("says how long until the next one, and is right about it", () => {
    const time = clock();
    const limiter = new RateLimiter({ burst: 1, refillMs: 60_000 }, time.now);

    limiter.take("1.2.3.4");
    const refused = limiter.take("1.2.3.4");
    expect(refused).toEqual({ allowed: false, retryAfterMs: 60_000 });

    time.advance(59_999);
    expect(limiter.take("1.2.3.4").allowed).toBe(false);
    time.advance(1);
    expect(limiter.take("1.2.3.4").allowed).toBe(true);
  });

  it("refills gradually rather than all at once", () => {
    const time = clock();
    const limiter = new RateLimiter({ burst: 4, refillMs: 10_000 }, time.now);
    for (let attempt = 0; attempt < 4; attempt += 1) limiter.take("1.2.3.4");

    // A fixed window would hand back the whole burst here. A bucket hands back one.
    time.advance(10_000);
    expect(limiter.take("1.2.3.4").allowed).toBe(true);
    expect(limiter.take("1.2.3.4").allowed).toBe(false);
  });

  it("never lets an idle caller bank more than the burst", () => {
    const time = clock();
    const limiter = new RateLimiter({ burst: 2, refillMs: 1_000 }, time.now);

    time.advance(60 * 60_000);
    expect(limiter.take("1.2.3.4").allowed).toBe(true);
    expect(limiter.take("1.2.3.4").allowed).toBe(true);
    expect(limiter.take("1.2.3.4").allowed).toBe(false);
  });

  it("counts each caller separately", () => {
    const time = clock();
    const limiter = new RateLimiter({ burst: 1, refillMs: 60_000 }, time.now);

    expect(limiter.take("1.2.3.4").allowed).toBe(true);
    expect(limiter.take("1.2.3.4").allowed).toBe(false);
    expect(limiter.take("5.6.7.8").allowed).toBe(true);
  });
});
