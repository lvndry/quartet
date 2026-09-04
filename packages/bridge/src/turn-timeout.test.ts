/**
 * @fileoverview That a dead turn says whose deadline killed it.
 *
 * The bug this guards read a five-minute failure and announced "the daemon has gone quiet
 * for 30m". Both quartet's idle watchdog and the runtime's own request timeout throw
 * `TimeoutError`, so the name could not tell them apart, and the log had nothing else in it
 * — no error shape, no progress count — to catch the claim being wrong. Reading the signal
 * instead of the error name is what makes the two distinguishable.
 */

import { describe, expect, test } from "bun:test";
import { createIdleWatchdog, runTurn } from "./jazz";

const daemon = { url: "http://127.0.0.1:1", webhook: "quartet", token: "t" } as const;

describe("createIdleWatchdog", () => {
  test("counts progress and reports how long the daemon has been silent", async () => {
    const watchdog = createIdleWatchdog(60_000);
    expect(watchdog.stats().pokes).toBe(0);

    watchdog.poke();
    watchdog.poke();
    await Bun.sleep(20);

    const stats = watchdog.stats();
    expect(stats.pokes).toBe(2);
    expect(stats.quietMs).toBeGreaterThanOrEqual(15);
    watchdog.dispose();
  });

  test("aborts only after the idle deadline, and a poke pushes it out", async () => {
    const watchdog = createIdleWatchdog(60);
    await Bun.sleep(40);
    watchdog.poke();
    await Bun.sleep(40);
    expect(watchdog.signal.aborted).toBe(false);

    await Bun.sleep(50);
    expect(watchdog.signal.aborted).toBe(true);
    expect((watchdog.signal.reason as Error).name).toBe("TimeoutError");
    watchdog.dispose();
  });
});

describe("runTurn", () => {
  test("blames the idle deadline only when the idle deadline actually fired", async () => {
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: async () => {
        await new Promise(() => {});
        return new Response("never");
      },
    });
    const watchdog = createIdleWatchdog(150);
    const result = await runTurn(
      { ...daemon, url: `http://127.0.0.1:${String(server.port)}` },
      "thread",
      "payload",
      watchdog,
    );
    watchdog.dispose();
    server.stop(true);

    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.reason).toContain("gone quiet");
  });

  test("turns off the runtime's own five-minute cap, so the watchdog is the only deadline", async () => {
    // Measured, not assumed: Bun's default gives up at 300.08s against a server that accepts
    // and never answers, and throws the same `TimeoutError` the watchdog does. Left on, it
    // silently capped every turn at five minutes while the code claimed thirty.
    const real = globalThis.fetch;
    let init: (RequestInit & { timeout?: boolean }) | undefined;
    globalThis.fetch = ((_url: string, options: RequestInit) => {
      init = options;
      throw new TypeError("stopped here");
    }) as unknown as typeof fetch;

    const watchdog = createIdleWatchdog(60_000);
    try {
      await runTurn(daemon, "thread", "payload", watchdog);
    } finally {
      globalThis.fetch = real;
      watchdog.dispose();
    }

    expect(init?.timeout).toBe(false);
    expect(init?.signal).toBe(watchdog.signal);
  });

  test("a daemon that is not listening is not reported as a timeout", async () => {
    const watchdog = createIdleWatchdog(60_000);
    const result = await runTurn(daemon, "thread", "payload", watchdog);
    watchdog.dispose();

    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.reason).toContain("not reachable");
  });
});
