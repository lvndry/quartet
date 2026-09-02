/**
 * @fileoverview A room with more than two agents in it, driven over the real wire.
 *
 * `smoke.ts` proves the loop closes for a pair, with real bridges and stand-in daemons.
 * This proves it closes for a room, and deliberately skips the bridges: what is on trial
 * here is the hub's idea of who is in a room, who a message wakes, and who is allowed to
 * bring somebody in. Speaking the protocol directly is the shortest path to those answers.
 *
 * Run with: bun scripts/trio.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeypair,
  linkAfter,
  newNonce,
  signChallenge,
  signClaim,
  signMessage,
  type Keypair,
} from "../packages/identity/src/index";
import { MAX_ROOM_MEMBERS } from "../packages/protocol/src/index";

const HUB_PORT = 8394;

const cleanups: (() => void)[] = [];

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Teardown is best-effort; the assertion failure is the thing worth reporting.
    }
  }
  process.exit(1);
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
  console.log(`  ✓ ${message}`);
}

interface Frame {
  t: string;
  [key: string]: unknown;
}

/** One participant's socket, holding every frame the hub has sent it. */
class Party {
  readonly frames: Frame[] = [];
  private socket!: WebSocket;
  private keypair!: Keypair;
  /** This party's own signing chain, one link per room. */
  private readonly chain = new Map<string, string>();

  constructor(readonly handle: string) {}

  async open(hubUrl: string, keypair: Keypair): Promise<void> {
    this.keypair = keypair;
    this.socket = new WebSocket(`${hubUrl.replace("http", "ws")}/socket`);
    // Listening before the open await, because the hub challenges the moment the socket is
    // up and a listener attached afterwards can miss it.
    const answered = new Promise<void>((resolve) => {
      this.socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Frame;
        this.frames.push(frame);
        if (frame.t !== "challenge") return;
        const nonce = String(frame["nonce"]);
        this.send({
          t: "hello",
          did: keypair.did,
          challenge: nonce,
          signature: signChallenge(keypair.did, nonce, keypair.privateKey),
        });
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error(`${this.handle} could not connect`)));
    });
    await answered;
    cleanups.push(() => this.socket.close());
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Speak in a room, signed the way a bridge signs, because the hub refuses unsigned lines. */
  say(conversationId: string, text: string): void {
    const authoredAt = new Date().toISOString();
    const nonce = newNonce();
    const prev = this.chain.get(conversationId) ?? "";
    const signature = signMessage(
      { did: this.keypair.did, conversationId, kind: "agent", authoredAt, nonce, prev, text },
      this.keypair.privateKey,
    );
    this.chain.set(conversationId, linkAfter(signature));
    this.send({
      t: "say",
      conversationId,
      text,
      authorship: { authoredAt, nonce, prev, signature },
    });
  }

  last<T = Frame>(kind: string): T | undefined {
    return [...this.frames].reverse().find((frame) => frame.t === kind) as T | undefined;
  }

  count(kind: string): number {
    return this.frames.filter((frame) => frame.t === kind).length;
  }

  /** The room as this party last heard it described. */
  room(): { id: string; participants: string[]; state: string } | undefined {
    const frame = this.last<{ conversation?: { id: string; participants: string[]; state: string } }>(
      "conversation",
    );
    return frame?.conversation;
  }
}

/** Frames cross a socket, so an assertion has to be given time to become true. */
async function settle(ms = 300): Promise<void> {
  await Bun.sleep(ms);
}

const workDir = await mkdtemp(join(tmpdir(), "quartet-trio-"));
const hub = Bun.spawn({
  cmd: ["bun", "run", "packages/hub/src/main.ts"],
  env: {
    ...process.env,
    PORT: String(HUB_PORT),
    QUARTET_DB: join(workDir, "hub.sqlite"),
    // Four handles in a few seconds is what this test is; the rule guards the open internet.
    QUARTET_REGISTRATION_BURST: "8",
  },
  stdout: "pipe",
  stderr: "pipe",
});
cleanups.push(() => hub.kill());

const hubUrl = `http://127.0.0.1:${String(HUB_PORT)}`;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const ok = await fetch(`${hubUrl}/health`).then((response) => response.ok).catch(() => false);
  if (ok) break;
  await Bun.sleep(100);
  if (attempt === 59) fail("hub never became healthy");
}
console.log("\nhub up\n");

async function claim(handle: string): Promise<Keypair> {
  const keypair = generateKeypair();
  const claimed = { did: keypair.did, handle, at: new Date().toISOString() };
  const response = await fetch(`${hubUrl}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...claimed,
      displayName: handle,
      signature: signClaim(claimed, keypair.privateKey),
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    fail(`could not claim @${handle}: ${body?.error ?? "unknown"}`);
  }
  return keypair;
}

const mira = new Party("mira");
const otto = new Party("otto");
const nia = new Party("nia");
const ada = new Party("ada");
for (const party of [mira, otto, nia, ada]) {
  await party.open(hubUrl, await claim(party.handle));
}
await settle();

// @mira knows @otto and @nia. Those two have never met, and nobody has met @ada.
for (const invitee of [otto, nia]) {
  mira.send({
    t: "invite.send",
    toHandle: invitee.handle,
    purpose: "what is free will",
    limit: { kind: "turns", turns: 100 },
  });
  await settle();
  const invite = invitee.last<{ invite?: { id?: string } }>("invite")?.invite;
  if (invite?.id === undefined) fail(`the invite never reached @${invitee.handle}`);
  invitee.send({ t: "invite.respond", inviteId: invite.id, accept: true });
  await settle();
}

const opened = mira.frames.filter((frame) => frame.t === "connected");
check(opened.length === 2, "two connections, each opening a room of its own");
const room = (opened[0] as { conversation: { id: string; participants: string[] } }).conversation;
check(room.participants.length === 2, "a room starts as the pair it grew from");
check(room.participants[0] === "mira", "and its first member is whoever opened it");

console.log("\nbringing a third agent in\n");
mira.send({ t: "conversation.add", conversationId: room.id, handle: "nia" });
await settle();

check(mira.room()?.participants.length === 3, "the room holds three agents");
check(mira.room()?.participants[2] === "nia", "the newcomer is last, having joined last");
check(nia.count("welcome") === 2, "the newcomer is sent the room and the history it missed");
const ottoSees = otto.last<{ others?: { handle: string }[] }>("presence")?.others ?? [];
check(ottoSees.length === 2, "@otto is told about both of the others");
check(
  ottoSees.map((entry) => entry.handle).sort().join(",") === "mira,nia",
  "including the one they had never been introduced to",
);

console.log("\none message, and who it wakes\n");
const before = { mira: mira.count("turn"), otto: otto.count("turn"), nia: nia.count("turn") };
mira.say(room.id, "free will is compatible with determinism");
await settle(500);
check(otto.count("turn") === before.otto + 1, "@otto's agent was asked for a turn");
check(nia.count("turn") === before.nia + 1, "@nia's agent was asked for a turn too");
check(mira.count("turn") === before.mira, "and @mira was never asked to answer herself");

console.log("\nwho may bring somebody in\n");
otto.send({ t: "conversation.add", conversationId: room.id, handle: "nia" });
await settle();
check(
  String(otto.last<{ detail?: string }>("error")?.detail ?? "").includes("already here"),
  "somebody already in the room cannot be added a second time",
);

// The rule that matters: a connection is where consent to talk to you at all was given, and
// knowing a handle is not a substitute for it.
otto.send({ t: "conversation.add", conversationId: room.id, handle: "ada" });
await settle();
check(
  String(otto.last<{ detail?: string }>("error")?.detail ?? "").includes("not connected"),
  "@otto cannot add @ada, whom he has never been introduced to",
);
check(ada.count("welcome") === 1, "and @ada was never put in the room");
check(mira.room()?.participants.length === 3, "the room is still the three it was");
check(MAX_ROOM_MEMBERS >= 3, `a room's ceiling is ${String(MAX_ROOM_MEMBERS)}, so three is allowed`);

console.log("\nwalking out\n");
nia.send({ t: "conversation.leave", conversationId: room.id });
await settle();
check(mira.room()?.participants.length === 2, "the room is a pair again");
check(mira.room()?.state === "live", "and still running, because two people is a conversation");
check(
  (nia.last<{ conversation?: { participants?: string[] } }>("conversation")?.conversation?.participants ?? []).every(
    (handle) => handle !== "nia",
  ),
  "the leaver is told they are out, so their app can stop showing the room",
);

otto.send({ t: "conversation.leave", conversationId: room.id });
await settle();
check(
  mira.room()?.state === "closed",
  "the last one out closes it rather than leaving @mira's agent talking to nobody",
);

console.log("\n  all good\n");
for (const cleanup of cleanups) {
  try {
    cleanup();
  } catch {
    // Nothing left to report; the run passed.
  }
}
await rm(workDir, { recursive: true, force: true });
process.exit(0);
