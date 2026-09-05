/**
 * @fileoverview What the bridge does when the hub says no, rather than when it goes away.
 *
 * The bug this exists for: a hub that had never seen this key answered the handshake with a
 * refusal and closed. The bridge treated that like any other disconnect, so it reconnected
 * once a second forever — and told the app it "can't reach the hub", about a hub that was
 * answering every single time.
 *
 * So the assertions here are about *stopping*, and about what is said instead.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, generateSealingKeypair } from "@quartet/identity";
import { REFUSED_CLOSE_CODE, type RefusalReason } from "@quartet/protocol";
import { Attestor } from "./attest";
import { Bridge } from "./bridge";
import { Sealer } from "./sealer";
import { setIdentityDirectory } from "./paths";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "quartet-refusal-"));
  setIdentityDirectory(workDir);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * A hub that refuses every socket, and counts how many it was offered.
 *
 * Deliberately not the real hub: what is under test is how this end reacts to an answer, and
 * the cheapest way to be sure the answer is the one under test is to say it directly.
 */
function refusingHub(reason: RefusalReason, detail: string) {
  let attempts = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, hub) {
      return hub.upgrade(request) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(socket) {
        attempts += 1;
        socket.send(JSON.stringify({ t: "challenge", nonce: "a-nonce" }));
      },
      message(socket) {
        socket.send(JSON.stringify({ t: "refused", reason, detail }));
        socket.close(REFUSED_CLOSE_CODE, reason);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    attempts: () => attempts,
    stop: () => server.stop(true),
  };
}

function bridgeFor(hubUrl: string): Bridge {
  return new Bridge(
    hubUrl,
    { url: "http://127.0.0.1:1", webhook: "quartet", token: "t" },
    new Attestor(generateKeypair()),
    new Sealer({ current: generateSealingKeypair(), retired: [] }),
  );
}

let running: Bridge | undefined;
let hub: ReturnType<typeof refusingHub> | undefined;

afterEach(() => {
  running?.stop();
  hub?.stop();
  running = undefined;
  hub = undefined;
});

async function waitFor(what: string, ready: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ready()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("a hub that refuses this key", () => {
  it("is not knocked on again", async () => {
    hub = refusingHub("unclaimed-key", "no agent has claimed that key");
    running = bridgeFor(hub.url);
    await running.start();

    await waitFor("the refusal to arrive", () => running?.snapshot().hubRefusal !== undefined);
    const after = hub.attempts();

    // The old loop reconnected on a one-second backoff, so this window would have held
    // several more attempts. One is the whole point: the answer cannot change.
    await Bun.sleep(2_500);
    expect(hub.attempts()).toBe(after);
    expect(after).toBe(1);
  });

  it("says what would fix it, not that the hub is unreachable", async () => {
    hub = refusingHub("unclaimed-key", "no agent has claimed that key");
    running = bridgeFor(hub.url);
    await running.start();

    await waitFor("the refusal to arrive", () => running?.snapshot().hubRefusal !== undefined);
    const state = running.snapshot();

    expect(state.hubRefusal?.reason).toBe("unclaimed-key");
    expect(state.hubRefusal?.claimable).toBe(true);
    expect(state.hubRefusal?.remedy).toContain("quartet connect");
    expect(state.connectedToHub).toBe(false);
    // The sentence that used to be shown here was about a hub that was answering perfectly
    // well, and it drowned the one that was true.
    expect(state.lastError ?? "").not.toContain("can't reach the hub");
  });

  it("does not offer a claim for a refusal a claim would not fix", async () => {
    hub = refusingHub("bad-sealing-key", "that sealing key is not signed by that did");
    running = bridgeFor(hub.url);
    await running.start();

    await waitFor("the refusal to arrive", () => running?.snapshot().hubRefusal !== undefined);

    expect(running.snapshot().hubRefusal?.claimable).toBe(false);
  });

  it("stops even when the refusal frame is lost and only the close code arrives", async () => {
    // A socket can die between the frame and the read. The close code carries the same
    // verdict precisely so that ending is still legible.
    let attempts = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request, self) {
        return self.upgrade(request) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        open(socket) {
          attempts += 1;
          socket.send(JSON.stringify({ t: "challenge", nonce: "a-nonce" }));
        },
        message(socket) {
          socket.close(REFUSED_CLOSE_CODE, "unclaimed-key");
        },
      },
    });
    running = bridgeFor(`http://127.0.0.1:${String(server.port)}`);
    await running.start();

    try {
      await waitFor("the close code to be read", () => running?.snapshot().hubRefusal !== undefined);
      expect(running.snapshot().hubRefusal?.reason).toBe("unclaimed-key");
      await Bun.sleep(2_500);
      expect(attempts).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
