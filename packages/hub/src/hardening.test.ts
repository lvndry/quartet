/**
 * @fileoverview What a hostile socket gets, against a real hub process.
 *
 * The unit suites cover policy and restart behaviour, and they cover it against the pieces
 * in isolation — which is exactly the wrong shape for the questions here. \"Can a bridge
 * speak without being asked\", \"does a captured frame work twice\", \"what stops a flood\"
 * are all questions about the hub's door, and the door is `Bun.serve` plus `handleFrame`
 * plus the store, wired together in `main.ts`. So this drives an actual hub over an actual
 * WebSocket, with real keys and real signatures, and tries the attacks.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeypair,
  generateSealingKeypair,
  linkAfter,
  newNonce,
  signChallenge,
  signClaim,
  signMessage,
  signSealingKey,
  type Keypair,
} from "@quartet/identity";

/** Bounded so a hub that never becomes healthy fails the suite rather than hanging it. */
const READY_TIMEOUT_MS = 15_000;
const SETTLE_MS = 250;

let hub: ReturnType<typeof Bun.spawn>;
let origin: string;
let socketOrigin: string;
let workDir: string;

async function waitFor(what: string, ready: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ready()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "quartet-hardening-"));
  const port = 8600 + Math.floor(Math.random() * 300);
  origin = `http://127.0.0.1:${String(port)}`;
  socketOrigin = `ws://127.0.0.1:${String(port)}`;
  hub = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: {
      ...process.env,
      PORT: String(port),
      QUARTET_DB: join(workDir, "hub.sqlite"),
      // Every party in here claims a handle, and a couple of tests claim several.
      QUARTET_REGISTRATION_BURST: "50",
      // So the anonymous-socket reaper can be watched without a ten-second pause.
      QUARTET_HELLO_GRACE_MS: "300",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitFor(
    "the hub to come up",
    async () => {
      try {
        return (await fetch(`${origin}/health`)).ok;
      } catch {
        return false;
      }
    },
    READY_TIMEOUT_MS,
  );
});

afterAll(async () => {
  hub.kill();
  await rm(workDir, { recursive: true, force: true });
});

interface Frame {
  t: string;
  [key: string]: unknown;
}

/**
 * One agent on a bare socket: real key, real signatures, no bridge in the way.
 *
 * Deliberately not the `Bridge` class. The point of every test below is that the hub holds
 * the line on its own, against a client that is not following the rules — and a client built
 * out of the code that follows them cannot ask that question.
 */
class Party {
  readonly frames: Frame[] = [];
  readonly keypair: Keypair = generateKeypair();
  socket!: WebSocket;
  closedWith: number | undefined;
  /** This agent's own signing chain, one link per room. */
  private readonly chain = new Map<string, string>();

  constructor(readonly handle: string) {}

  async claim(): Promise<Response> {
    const at = new Date().toISOString();
    return fetch(`${origin}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: this.handle,
        displayName: this.handle,
        did: this.keypair.did,
        at,
        signature: signClaim({ did: this.keypair.did, handle: this.handle, at }, this.keypair.privateKey),
      }),
    });
  }

  async connect(options: { sayHello?: boolean; forgeSealingKey?: boolean } = {}): Promise<void> {
    this.socket = new WebSocket(`${socketOrigin}/socket`);
    this.socket.addEventListener("close", (event) => {
      this.closedWith = event.code;
    });
    // Listening before the open await: the hub challenges the instant the socket is up, and
    // a listener attached afterwards can miss it.
    const greeted = new Promise<void>((resolve) => {
      this.socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Frame;
        this.frames.push(frame);
        if (frame.t !== "challenge") return;
        if (options.sayHello === false) {
          resolve();
          return;
        }
        const nonce = String(frame["nonce"]);
        const at = new Date().toISOString();
        const sealingDid = generateSealingKeypair().sealingDid;
        // Signed by somebody else's key: exactly the shape of a hub substituting a sealing
        // key it holds the private half of, and the one thing the door has to catch.
        const signer = options.forgeSealingKey === true ? generateKeypair() : this.keypair;
        this.send({
          t: "hello",
          did: this.keypair.did,
          challenge: nonce,
          signature: signChallenge(this.keypair.did, nonce, this.keypair.privateKey),
          // A real bridge's handshake, so the door these tests attack is the real one. The
          // key is thrown away: nothing here opens anything, and a hub that let this through
          // unsigned would be the bug rather than the fixture.
          sealing: {
            sealingDid,
            at,
            proof: signSealingKey({ did: signer.did, sealingDid, at }, signer.privateKey),
          },
        });
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error(`@${this.handle} could not connect`)));
    });
    await greeted;
    // A forged sealing key is refused at the door, so there is no welcome to wait for.
    if (options.sayHello !== false && options.forgeSealingKey !== true) {
      await this.waitForFrame("welcome");
    }
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** A `say` frame, signed exactly as a well-behaved bridge would sign it. */
  saying(conversationId: string, dispatch: string, text: string): Record<string, unknown> {
    const authoredAt = new Date().toISOString();
    const nonce = newNonce();
    const prev = this.chain.get(conversationId) ?? "";
    const signature = signMessage(
      { did: this.keypair.did, conversationId, kind: "agent", authoredAt, nonce, prev, dispatch, text },
      this.keypair.privateKey,
    );
    this.chain.set(conversationId, linkAfter(signature));
    return {
      t: "say",
      conversationId,
      dispatch,
      text,
      authorship: { authoredAt, nonce, prev, signature },
    };
  }

  seen(kind: string): Frame[] {
    return this.frames.filter((frame) => frame.t === kind);
  }

  last(kind: string): Frame | undefined {
    return [...this.frames].reverse().find((frame) => frame.t === kind);
  }

  async waitForFrame(kind: string, ms = 5_000): Promise<Frame> {
    await waitFor(`@${this.handle} to receive a ${kind}`, () => this.last(kind) !== undefined, ms);
    const frame = this.last(kind);
    if (frame === undefined) throw new Error("unreachable");
    return frame;
  }

  errors(): string[] {
    return this.seen("error").map((frame) => String(frame["detail"]));
  }
}

/** Two connected agents in a live room, with the opener holding the first turn. */
async function aRoom(names: [string, string]) {
  const [first, second] = [new Party(names[0]), new Party(names[1])];
  for (const party of [first, second]) {
    const claimed = await party.claim();
    expect(claimed.status).toBe(201);
  }
  await first.connect();
  await second.connect();

  first.send({ t: "invite.send", toHandle: second.handle, purpose: "find a time" });
  const invite = await second.waitForFrame("invite");
  second.send({ t: "invite.respond", inviteId: String(invite["inviteId"] ?? (invite["invite"] as { id: string }).id), accept: true });

  const connected = await first.waitForFrame("connected");
  const conversationId = (connected["conversation"] as { id: string }).id;
  // Accepting steers the inviter's agent with the purpose, so the first turn is theirs.
  const turn = await first.waitForFrame("turn");
  return { first, second, conversationId, dispatch: String(turn["dispatch"]) };
}

describe("speaking without being asked", () => {
  it("refuses a validly signed line from an agent holding no turn", async () => {
    const { second, conversationId } = await aRoom(["ada", "bram"]);
    // @bram is a member and signs perfectly well. What he does not have is the floor: the
    // hub dispatched no turn to him, so nothing he says here should reach the room — and
    // nothing should wake @ada's agent, on @ada's key, at @ada's expense.
    second.send(second.saying(conversationId, "a-turn-nobody-gave-out", "hello?"));
    await Bun.sleep(SETTLE_MS);

    expect(second.errors().join(" ")).toContain("not holding that turn");
    expect(second.seen("appended").some((frame) => {
      return (frame["message"] as { text: string }).text === "hello?";
    })).toBe(false);
  });

  it("refuses a heartbeat for a turn that was never dispatched", async () => {
    const { second, conversationId } = await aRoom(["cleo", "dane"]);
    // "@dane's agent is reading your calendar" is a line in somebody else's room too.
    second.send({ t: "progress", conversationId, dispatch: "invented", note: "read_calendar" });
    await Bun.sleep(SETTLE_MS);

    expect(second.errors().join(" ")).toContain("not holding that turn");
  });
});

describe("a frame captured off the wire", () => {
  it("is refused the second time it is sent", async () => {
    const { first, conversationId, dispatch } = await aRoom(["elia", "fen"]);
    const frame = first.saying(conversationId, dispatch, "the same line twice");

    first.send(frame);
    await waitFor("the first copy to land", () =>
      first.seen("appended").some((f) => (f["message"] as { text: string }).text === "the same line twice"),
    );

    // Byte for byte what a listener on the path would have recorded. It verifies just as
    // well as it did the first time — which is the whole reason a signature alone was never
    // enough here.
    first.send(frame);
    await Bun.sleep(SETTLE_MS);

    const landed = first
      .seen("appended")
      .filter((f) => (f["message"] as { text: string }).text === "the same line twice");
    expect(landed).toHaveLength(1);
    expect(first.errors().join(" ")).toMatch(/already been answered|not yours to answer/);
  });

  it("is refused under a fresh dispatch too, because the nonce is spent", async () => {
    const { first, second, conversationId, dispatch } = await aRoom(["gale", "hana"]);
    const frame = first.saying(conversationId, dispatch, "once only");
    first.send(frame);
    await waitFor("the line to land", () =>
      first.seen("appended").some((f) => (f["message"] as { text: string }).text === "once only"),
    );

    // @hana answers, which earns @gale a new turn — so the dispatch check alone would let
    // the captured line through again. The nonce is what stops it.
    const hanasTurn = await second.waitForFrame("turn");
    second.send(second.saying(conversationId, String(hanasTurn["dispatch"]), "go on"));
    const galesNextTurn = await waitFor("a second turn for @gale", () => first.seen("turn").length > 1)
      .then(() => first.seen("turn")[1]);

    first.send({ ...frame, dispatch: String(galesNextTurn?.["dispatch"]) });
    await Bun.sleep(SETTLE_MS);

    const landed = first
      .seen("appended")
      .filter((f) => (f["message"] as { text: string }).text === "once only");
    expect(landed).toHaveLength(1);
  });
});

describe("erasing a shared room", () => {
  it("takes everybody, and says so in the room while it waits", async () => {
    const { first, second, conversationId } = await aRoom(["iris", "jonas"]);

    first.send({ t: "conversation.delete", conversationId, scope: "everyone" });
    const note = await waitFor("the room to be told somebody asked", () =>
      second.seen("appended").some((frame) => {
        return (frame["message"] as { text: string }).text.includes("asked to erase this room");
      }),
    ).then(() => true);
    expect(note).toBe(true);

    // One member is not a quorum. @jonas took part in this and paid for his half of it.
    expect(second.seen("conversation.removed")).toHaveLength(0);
    const marked = second.last("conversation");
    expect((marked?.["conversation"] as { eraseAsked: string[] }).eraseAsked).toEqual(["iris"]);

    second.send({ t: "conversation.delete", conversationId, scope: "everyone" });
    await waitFor("the room to go once both have asked", () => second.seen("conversation.removed").length === 1);
    expect(first.seen("conversation.removed")).toHaveLength(1);
  });

  it("does not repeat itself when one member asks twice", async () => {
    const { first, second, conversationId } = await aRoom(["kai", "lena"]);
    first.send({ t: "conversation.delete", conversationId, scope: "everyone" });
    await waitFor("the first ask to be announced", () =>
      second.seen("appended").some((frame) =>
        (frame["message"] as { text: string }).text.includes("asked to erase"),
      ),
    );
    first.send({ t: "conversation.delete", conversationId, scope: "everyone" });
    await Bun.sleep(SETTLE_MS);

    const asks = second
      .seen("appended")
      .filter((frame) => (frame["message"] as { text: string }).text.includes("asked to erase"));
    expect(asks).toHaveLength(1);
    expect(second.seen("conversation.removed")).toHaveLength(0);
  });

  it("leaves the room for everybody else when one member only hides it", async () => {
    const { first, second, conversationId } = await aRoom(["mo", "nell"]);
    first.send({ t: "conversation.delete", conversationId, scope: "me" });
    await waitFor("@mo's own copy to go", () => first.seen("conversation.removed").length === 1);
    await Bun.sleep(SETTLE_MS);

    // Hiding is not agreeing, and it is nobody else's business.
    expect(second.seen("conversation.removed")).toHaveLength(0);
    expect(
      second.seen("appended").some((frame) =>
        (frame["message"] as { text: string }).text.includes("asked to erase"),
      ),
    ).toBe(false);
  });
});

describe("a socket that misbehaves", () => {
  it("is closed when its sealing key is not signed by the did it just proved", async () => {
    // Answering the challenge proves a signing key. It says nothing about the *sealing* key
    // presented alongside it, and a hub that relayed one unchecked would be handing every
    // room a key it might have minted — which is to say, reading the room.
    const forger = new Party("wren");
    expect((await forger.claim()).status).toBe(201);
    await forger.connect({ forgeSealingKey: true });

    await waitFor("the forged sealing key to close the socket", () => forger.closedWith !== undefined);
    expect(forger.errors().join(" ")).toContain("sealing key");
    // Refused at the door: no welcome, so nothing was relayed to it either.
    expect(forger.frames.some((frame) => frame.t === "welcome")).toBe(false);
  });

  it("is closed when it never says who it is", async () => {
    const lurker = new Party("nobody");
    await lurker.connect({ sayHello: false });

    await waitFor("the anonymous socket to be closed", () => lurker.closedWith !== undefined, 3_000);
    expect(lurker.closedWith).toBe(1008);
  });

  it("is closed when it floods frames", async () => {
    const flooder = new Party("olive");
    expect((await flooder.claim()).status).toBe(201);
    await flooder.connect();

    // Far above anything a turn produces, and sent as fast as a loop can write it.
    for (let sent = 0; sent < 400; sent += 1) flooder.send({ t: "directory.list" });

    await waitFor("the flooding socket to be closed", () => flooder.closedWith !== undefined, 3_000);
    expect(flooder.errors().join(" ")).toContain("too many frames");
  });

  it("is closed when it sends a frame far larger than any real one", async () => {
    const shouter = new Party("piet");
    expect((await shouter.claim()).status).toBe(201);
    await shouter.connect();

    // Bun refuses this at the protocol level rather than buffering it, which is the point:
    // a size limit that only binds after the bytes are in memory is not a size limit.
    shouter.socket.send(JSON.stringify({ t: "directory.list", pad: "x".repeat(300_000) }));

    await waitFor("the oversized frame to close the socket", () => shouter.closedWith !== undefined, 3_000);
  });

  it("still serves everybody else afterwards", async () => {
    const quiet = new Party("rue");
    expect((await quiet.claim()).status).toBe(201);
    await quiet.connect();
    quiet.send({ t: "directory.list" });

    await quiet.waitForFrame("directory");
    expect(quiet.closedWith).toBeUndefined();
  });
});
