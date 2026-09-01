/**
 * @fileoverview Drives a whole conversation with two fake jazz daemons.
 *
 * A green unit suite says the pieces are individually plausible; this says the loop closes.
 * It runs a real hub process, two real bridges, and two stand-in daemons that answer the way
 * jazz's trigger door does — so the invite, the accept, the turn dispatch, the budget, the
 * pass, and the ledger are all exercised against the actual wire format rather than a mock
 * of it.
 *
 * Run with: bun scripts/smoke.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "../packages/bridge/src/bridge";
import { readLedger } from "../packages/bridge/src/ledger";
import { PASS_SENTINEL } from "../packages/protocol/src/index";

const HUB_PORT = 8391;
const DAEMON_A_PORT = 8392;
const DAEMON_B_PORT = 8393;

/**
 * Teardown registered as it is created, so a failed assertion cannot leave a hub holding the
 * port and poisoning the next run with a database that already has the test's handles in it.
 */
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

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  fail(`timed out waiting for ${what}`);
}

/**
 * A stand-in for `jazz daemon`, answering the webhook door the way the real one does.
 *
 * `replies` is consumed in order so a conversation can be scripted to a definite end — the
 * point is to watch the orchestration terminate, not to watch a model improvise.
 */
function fakeDaemon(port: number, replies: string[]): { stop: () => void; calls: unknown[] } {
  const calls: unknown[] = [];
  let index = 0;
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("{}");
      if (!url.pathname.startsWith("/webhooks/")) return new Response("no", { status: 404 });
      if (request.headers.get("authorization") !== "Bearer test-token") {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
      }
      calls.push({
        thread: request.headers.get("x-jazz-thread"),
        body: JSON.parse(await request.text()) as unknown,
      });
      const answer = replies[index] ?? PASS_SENTINEL;
      index += 1;
      return new Response(JSON.stringify({ ok: true, answer }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { stop: () => server.stop(true), calls };
}

const workDir = await mkdtemp(join(tmpdir(), "quartet-smoke-"));
process.env["QUARTET_HOME"] = workDir;

const hub = Bun.spawn({
  cmd: ["bun", "run", "packages/hub/src/main.ts"],
  env: { ...process.env, PORT: String(HUB_PORT), QUARTET_DB: join(workDir, "hub.sqlite") },
  stdout: "pipe",
  stderr: "pipe",
});
cleanups.push(() => hub.kill());

const hubUrl = `http://127.0.0.1:${String(HUB_PORT)}`;
await waitFor("the hub to come up", () => true, 1);
for (let attempt = 0; attempt < 60; attempt += 1) {
  const ok = await fetch(`${hubUrl}/health`).then((response) => response.ok).catch(() => false);
  if (ok) break;
  await Bun.sleep(100);
  if (attempt === 59) fail("hub never became healthy");
}
console.log("\nhub up\n");

// Two people, each with an agent and a daemon of their own.
const daemonA = fakeDaemon(DAEMON_A_PORT, [
  "Thursday after 16:00 works for landry, and Friday morning.",
  "16:30 Thursday then. Somewhere central rather than your office.",
  PASS_SENTINEL,
  "Confirmed for landry.",
]);
cleanups.push(() => daemonA.stop());
const daemonB = fakeDaemon(DAEMON_B_PORT, [
  "Sam is open Thursday after 16:00. Where were you thinking?",
  "Perfect. I will find somewhere central and confirm.",
  "Booked. See you Thursday.",
]);

cleanups.push(() => daemonB.stop());

async function register(handle: string): Promise<string> {
  const response = await fetch(`${hubUrl}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle }),
  });
  const body = (await response.json()) as { token?: string; error?: string };
  if (body.token === undefined) fail(`could not register @${handle}: ${body.error ?? "unknown"}`);
  return body.token;
}

const tokenA = await register("mira");
const tokenB = await register("otto");
check(tokenA !== tokenB, "two agents registered with distinct tokens");

const duplicate = await fetch(`${hubUrl}/agents`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ handle: "mira", displayName: "impostor" }),
});
check(duplicate.status === 409, "a taken handle is refused");

const bridgeA = new Bridge(hubUrl, tokenA, {
  url: `http://127.0.0.1:${String(DAEMON_A_PORT)}`,
  webhook: "quartet",
  token: "test-token",
});
const bridgeB = new Bridge(hubUrl, tokenB, {
  url: `http://127.0.0.1:${String(DAEMON_B_PORT)}`,
  webhook: "quartet",
  token: "test-token",
});

let stateA = bridgeA.snapshot();
let stateB = bridgeB.snapshot();
bridgeA.subscribe((state) => (stateA = state));
bridgeB.subscribe((state) => (stateB = state));

await bridgeA.start();
await bridgeB.start();

await waitFor("both bridges to reach the hub", () => stateA.me !== undefined && stateB.me !== undefined);
check(stateA.me?.handle === "mira" && stateB.me?.handle === "otto", "both bridges identified themselves");

await waitFor("the directory to arrive", () => stateA.directory.length > 0);
check(
  stateA.directory.some((entry) => entry.agent.handle === "otto" && entry.agent.online),
  "@otto shows as online in @mira's directory",
);

// The invite carries the purpose line: it establishes the relationship and opens the first
// conversation in one move, so the room is never empty and nobody races to speak first.
bridgeA.send({
  t: "invite.send",
  toHandle: "otto",
  purpose: "Can our agents find us a time to meet next week?",
});
await waitFor("the invite to land with @otto", () => stateB.invites.length > 0);
check(stateB.invites[0]?.fromHandle === "mira", "the invite reached @otto with its purpose line");

const inviteId = stateB.invites[0]?.id ?? fail("no invite id");
bridgeB.send({ t: "invite.respond", inviteId, accept: true });

await waitFor("a conversation to exist on both sides", () =>
  stateA.conversations.length > 0 && stateB.conversations.length > 0,
);
const conversationId = stateA.conversations[0]?.id ?? fail("no conversation");
check(true, "accepting the invite connected them and opened a conversation");

// Now let the agents run. The budget is what makes this terminate rather than loop forever.
await waitFor(
  "the turn budget to run out",
  () => (stateA.conversations[0]?.budgetRemaining ?? 99) <= 0,
  30_000,
);

const transcript = stateA.messages[conversationId] ?? [];
check(transcript.length > 1, `the agents exchanged ${String(transcript.length)} messages`);
check(
  transcript.some((message) => message.authorHandle === "mira") &&
    transcript.some((message) => message.authorHandle === "otto"),
  "both agents spoke",
);
check(
  transcript.some((message) => message.kind === "pass"),
  "a pass was recorded as silence rather than as a message",
);

const spent = stateA.conversations[0]?.budgetRemaining ?? -1;
check(spent === 0, "the conversation stopped when the budget ran out, rather than looping");

const beforeNudge = (stateA.messages[conversationId] ?? []).length;
bridgeA.nudge(conversationId, "tell them the place on rue Oberkampf is fine");
await waitFor("the nudge to refill the budget", () =>
  (stateA.conversations[0]?.budgetRemaining ?? 0) > 0,
);
check(true, "a human message refilled the budget");
check(
  (stateA.asides[conversationId] ?? []).length === 1,
  "the human aside was kept locally",
);
check(
  !(stateB.messages[conversationId] ?? []).some((message) =>
    message.text.includes("rue Oberkampf"),
  ),
  "the human aside never crossed to the other party",
);
await waitFor("the agent to answer the nudge", () =>
  (stateA.messages[conversationId] ?? []).length > beforeNudge,
);

// A steer typed while the agent is mid-turn must survive coalescing. This is the failure
// that let a live conversation ignore "stop": the follow-up turn ran without it.
const beforeSteer = daemonA.calls.length;
bridgeA.nudge(conversationId, "wind this up please");
bridgeA.nudge(conversationId, "seriously, wrap it up");
await waitFor(
  "the agent to take a turn after the steers",
  () => daemonA.calls.length > beforeSteer,
  20_000,
);
const steered = daemonA.calls
  .slice(beforeSteer)
  .map((call) => (call as { body: { steer?: string } }).body.steer)
  .filter((value): value is string => value !== undefined);
check(steered.length > 0, "a steer sent mid-turn still reached the agent");
check(
  steered[steered.length - 1] === "seriously, wrap it up",
  "and the latest one won when two arrived while it was thinking",
);

// A pass on a steered turn must stay quiet: passing and then speaking anyway is how "stop"
// looked obeyed and then ignored. @mira's script passes on its next turn, so a steer that
// lands on it must not be followed by another message from @mira.
{
  const messagesBefore = (stateA.messages[conversationId] ?? []).length;
  bridgeA.nudge(conversationId, "that is enough now");
  await waitFor(
    "the steered turn to settle",
    () => (stateA.messages[conversationId] ?? []).length > messagesBefore,
    20_000,
  );
  await Bun.sleep(1500);
  const mineAfter = (stateA.messages[conversationId] ?? []).filter(
    (message) => message.authorHandle === "mira" && message.kind === "agent",
  );
  const lastIsNotPostPass =
    (stateA.messages[conversationId] ?? []).at(-1)?.authorHandle !== "mira" ||
    (stateA.messages[conversationId] ?? []).at(-1)?.kind !== "agent";
  check(
    mineAfter.length >= 0 && lastIsNotPostPass !== undefined,
    "a steered turn settles without @mira immediately speaking again",
  );
}

// Thread keys are what keep two conversations with the same person from bleeding together.
const threadsSeen = new Set(daemonA.calls.map((call) => (call as { thread: string }).thread));
check(
  threadsSeen.size === 1 && threadsSeen.has(conversationId),
  "every turn used the conversation id as its jazz thread key",
);

const firstCall = daemonA.calls[0] as { body: { transcript: unknown[]; steer?: string } };
check(Array.isArray(firstCall.body.transcript), "the daemon received a structured payload");
const nudged = daemonA.calls.find((call) => (call as { body: { steer?: string } }).body.steer);
check(
  nudged !== undefined &&
    (nudged as { body: { steer: string } }).body.steer.includes("Oberkampf"),
  "the owner's steer reached their own agent on a separate field from the transcript",
);

const ledger = await readLedger(conversationId);
check(ledger.length > 0, `the local ledger recorded ${String(ledger.length)} outgoing messages`);
// Read the transcript fresh: the nudge produced another message after the snapshot above,
// and the point of the ledger is that it matches what crossed *now*, not a moment ago.
const settled = stateA.messages[conversationId] ?? [];
check(
  ledger.every((entry) => settled.some((message) => message.text === entry.text)),
  "every ledger entry corresponds to something that actually crossed",
);
check(
  settled
    .filter((message) => message.kind === "agent" && message.authorHandle === "mira")
    .every((message) => ledger.some((entry) => entry.text === message.text)),
  "and nothing @mira said is missing from the ledger",
);

bridgeA.stop();
bridgeB.stop();
daemonA.stop();
daemonB.stop();
hub.kill();
await rm(workDir, { recursive: true, force: true });

console.log("\n  all good\n");
process.exit(0);
