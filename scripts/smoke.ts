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
import { generateKeypair, signClaim, tag, type Keypair } from "../packages/identity/src/index";
import { Attestor } from "../packages/bridge/src/attest";
import { Journal } from "../packages/bridge/src/journal";
import { KnownKeys } from "../packages/bridge/src/known";

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

async function waitFor(
  what: string,
  predicate: () => boolean,
  timeoutMs = 15_000,
  describe?: () => unknown,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  const seen = describe === undefined ? "" : ` — saw ${JSON.stringify(describe())}`;
  fail(`timed out waiting for ${what}${seen}`);
}

/**
 * A stand-in for `jazz daemon`, answering the webhook door the way the real one does.
 *
 * `replies` is consumed in order so a conversation can be scripted to a definite end — the
 * point is to watch the orchestration terminate, not to watch a model improvise.
 */
function fakeDaemon(
  port: number,
  replies: string[],
): { stop: () => void; calls: unknown[]; forceNext: (answer: string) => void } {
  const calls: unknown[] = [];
  let index = 0;
  /**
   * A one-shot answer that jumps the queue.
   *
   * The script below cycles, so which line an agent gives on any particular turn depends on
   * how many turns have already run — fine for the conversation itself, useless for a test
   * that needs *this* turn to be a pass. Forcing it says what the assertion depends on
   * instead of hoping the arithmetic still lands there.
   */
  let forced: string | undefined;
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
      // Cycles rather than falling silent, so the only thing that can end a room here is the
      // budget — an agent that runs out of script would end it by mutual silence instead and
      // the exhaustion assertion below would pass without ever testing exhaustion.
      let answer: string;
      if (forced !== undefined) {
        answer = forced;
        forced = undefined;
      } else {
        answer = replies[index % replies.length] ?? PASS_SENTINEL;
        index += 1;
      }
      return new Response(JSON.stringify({ ok: true, answer }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    stop: () => server.stop(true),
    calls,
    forceNext: (answer: string) => {
      forced = answer;
    },
  };
}

const workDir = await mkdtemp(join(tmpdir(), "quartet-smoke-"));
process.env["QUARTET_HOME"] = workDir;

const hub = Bun.spawn({
  cmd: ["bun", "run", "packages/hub/src/main.ts"],
  env: {
    ...process.env,
    PORT: String(HUB_PORT),
    QUARTET_DB: join(workDir, "hub.sqlite"),
    // This run claims a handful of handles, several of them deliberately bad ones. The real
    // ceiling is exercised on its own below rather than by letting it trip mid-scenario.
    QUARTET_REGISTRATION_BURST: "8",
  },
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

async function claim(handle: string, keypair: Keypair): Promise<Response> {
  const body = { did: keypair.did, handle, at: new Date().toISOString() };
  return fetch(`${hubUrl}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...body,
      displayName: handle,
      signature: signClaim(body, keypair.privateKey),
    }),
  });
}

async function register(handle: string, keypair: Keypair): Promise<void> {
  const response = await claim(handle, keypair);
  if (!response.ok) {
    const body = (await response.json()) as { error?: string };
    fail(`could not register @${handle}: ${body.error ?? "unknown"}`);
  }
}

const keyA = generateKeypair();
const keyB = generateKeypair();
await register("mira", keyA);
await register("otto", keyB);
check(keyA.did !== keyB.did, "two agents claimed handles with keys of their own");

check((await claim("mira", generateKeypair())).status === 409, "a taken handle is refused");
check((await claim("mira2", keyA)).status === 409, "one key cannot hold two handles");

const unsigned = await fetch(`${hubUrl}/agents`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ handle: "nobody", displayName: "nobody" }),
});
check(unsigned.status === 400, "a claim without a key is refused");

const forgedAt = new Date().toISOString();
const forged = await fetch(`${hubUrl}/agents`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    did: keyA.did,
    handle: "impostor",
    at: forgedAt,
    displayName: "impostor",
    signature: signClaim({ did: keyB.did, handle: "impostor", at: forgedAt }, keyB.privateKey),
  }),
});
check(forged.status === 401, "a claim signed by another key is refused");

// The ceiling is raised for this run so the cases above fit, but it still has to bite: a
// script working through a handle list is exactly what it is there to stop.
let refusal: Response | undefined;
for (let attempt = 0; attempt < 8 && refusal === undefined; attempt += 1) {
  const response = await claim(`spare${String(attempt)}`, generateKeypair());
  if (response.status === 429) refusal = response;
}
check(refusal !== undefined, "claiming handles in a run eventually hits the ceiling");
check(
  refusal?.headers.get("retry-after") !== null,
  "and the refusal says how long to wait rather than just saying no",
);

const bridgeA = new Bridge(
  hubUrl,
  { url: `http://127.0.0.1:${String(DAEMON_A_PORT)}`, webhook: "quartet", token: "test-token" },
  new Attestor(keyA, new Journal(join(workDir, "chain-mira.json"))),
  // Two bridges in one process, so each is pointed at its own pin file — on a real host
  // these are two data directories and the default would already be separate.
  new KnownKeys(join(workDir, "known-mira.json")),
);
const bridgeB = new Bridge(
  hubUrl,
  { url: `http://127.0.0.1:${String(DAEMON_B_PORT)}`, webhook: "quartet", token: "test-token" },
  new Attestor(keyB, new Journal(join(workDir, "chain-otto.json"))),
  new KnownKeys(join(workDir, "known-otto.json")),
);

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

const PURPOSE = "Can our agents find us a time to meet next week?";
const LIMIT = { kind: "turns", turns: 12 } as const;

// The fingerprint is what somebody reads to you over another channel. A wrong one stops the
// invite rather than warning about it: this is the one moment where the sender has
// independent knowledge of who they mean, so refusing beats explaining afterwards.
check(
  bridgeA.invite("@otto#0000-0000-0000-0000", PURPOSE)?.error.includes("Do not send this") === true,
  "an invite whose fingerprint does not match the hub's key is refused outright",
);
check(
  bridgeA.invite("@nobody#0000-0000-0000-0000", PURPOSE)?.error.includes("no key") === true,
  "and a fingerprint for a handle the hub has never heard of proves nothing",
);

// The invite carries the topic. Accepting starts the inviter's agent with that as a steer —
// the sentence itself must not appear in the room as if the agent said it.
const ottoTag = tag("otto", keyB.did) ?? "otto";
check(
  bridgeA.invite(ottoTag, PURPOSE, LIMIT) === undefined,
  `the invite goes out when the fingerprint matches (${ottoTag})`,
);
await waitFor("the invite to land with @otto", () => stateB.invites.length > 0);
check(stateB.invites[0]?.fromHandle === "mira", "the invite reached @otto with its purpose line");
check(
  stateB.invites[0]?.limit.kind === "turns" && stateB.invites[0].limit.turns === 12,
  "the invite carried the inviter's limit",
);

const inviteId = stateB.invites[0]?.id ?? fail("no invite id");
bridgeB.send({ t: "invite.respond", inviteId, accept: true });

await waitFor("a conversation to exist on both sides", () =>
  stateA.conversations.length > 0 && stateB.conversations.length > 0,
);
const conversationId = stateA.conversations[0]?.id ?? fail("no conversation");
check(true, "accepting the invite connected them and opened a conversation");
check(
  stateA.conversations[0]?.limit.kind === "turns" && stateA.conversations[0].limit.turns === 12,
  "accepting used the inviter's limit, not a second pick",
);

bridgeA.send({ t: "watch", conversationId });
await waitFor(
  "@otto to see @mira watching",
  () => stateB.presence[conversationId]?.[0]?.watching === true,
);
// One other party in a two-party room, so the list has exactly one entry in it.
const miraInTheRoom = stateB.presence[conversationId]?.[0];
check(stateB.presence[conversationId]?.length === 1, "the room reports exactly one other party");
check(miraInTheRoom?.online === true, "@mira shows as online in the room");
check(miraInTheRoom?.watching === true, "@otto can see @mira is watching");

await waitFor(
  "both agents to speak and one to pass",
  () => {
    const messages = stateA.messages[conversationId] ?? [];
    return (
      messages.some((message) => message.authorHandle === "mira" && message.kind === "agent") &&
      messages.some((message) => message.authorHandle === "otto" && message.kind === "agent") &&
      messages.some((message) => message.kind === "pass")
    );
  },
  30_000,
  () => stateA.messages[conversationId]?.map((message) => `${message.authorHandle}:${message.kind}`),
);

const transcript = stateA.messages[conversationId] ?? [];
check(transcript.length > 1, `the agents exchanged ${String(transcript.length)} messages`);
check(
  !transcript.some((message) => message.kind === "agent" && message.text === PURPOSE),
  "the purpose was a steer, not an agent utterance in the room",
);
check(
  transcript.some((message) => message.kind === "pass"),
  "a pass was recorded as silence rather than as a message",
);
const firstCall = daemonA.calls[0] as { body: { transcript: unknown[]; steer?: string } };
check(
  firstCall?.body.steer === PURPOSE,
  "the inviter's agent was steered with the purpose before it spoke",
);

const beforeNudge = (stateA.messages[conversationId] ?? []).length;
bridgeA.nudge(conversationId, "tell them the place on rue Oberkampf is fine");
await waitFor("the nudge to be kept locally", () =>
  (stateA.asides[conversationId] ?? []).length === 1,
);
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
  // The next turn is a pass, deliberately rather than by counting where the script's cycle
  // happens to be. Passing and then speaking anyway is how "stop" looks obeyed and ignored.
  daemonA.forceNext(PASS_SENTINEL);
  bridgeA.nudge(conversationId, "that is enough now");
  await waitFor(
    "the steered turn to settle",
    () => (stateA.messages[conversationId] ?? []).length > messagesBefore,
    20_000,
  );
  await Bun.sleep(1500);
  const lastIsNotPostPass =
    (stateA.messages[conversationId] ?? []).at(-1)?.authorHandle !== "mira" ||
    (stateA.messages[conversationId] ?? []).at(-1)?.kind !== "agent";
  check(lastIsNotPostPass, "a steered turn settles without @mira immediately speaking again");
}

// Thread keys are what keep two conversations with the same person from bleeding together.
const threadsSeen = new Set(daemonA.calls.map((call) => (call as { thread: string }).thread));
check(
  threadsSeen.size === 1 && threadsSeen.has(conversationId),
  "every turn used the conversation id as its jazz thread key",
);

check(Array.isArray(firstCall.body.transcript), "the daemon received a structured payload");
const steersSeen = daemonA.calls
  .map((call) => (call as { body: { steer?: string } }).body.steer)
  .filter((steer): steer is string => steer !== undefined);
check(
  steersSeen.some((steer) => steer.includes("Oberkampf")),
  `the owner's steer reached their own agent on a separate field from the transcript${
    steersSeen.some((steer) => steer.includes("Oberkampf")) ? "" : ` — saw ${JSON.stringify(steersSeen)}`
  }`,
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

// Every line in the room carries a signature, and both ends agree it holds. This is the
// property the whole identity layer exists for: @otto's bridge concluded that @mira said
// what the hub claims she said, without having to take the hub's word for any of it.
const shared = stateB.messages[conversationId] ?? [];
const spoken = shared.filter((message) => message.kind !== "system");
check(
  spoken.length > 0 && spoken.every((message) => stateB.verdicts[message.id]?.state === "signed"),
  `@otto verified all ${String(spoken.length)} spoken lines, the opening one and the passes included`,
);
check(
  (stateA.messages[conversationId] ?? [])
    .filter((message) => message.kind !== "system")
    .every((message) => stateA.verdicts[message.id]?.state === "signed"),
  "and @mira verified her own lines coming back, rather than trusting the hub to echo them",
);
// The hub speaks in its own voice for a stop or a failed turn. Those are unsigned, and that
// is correct — there is no agent behind them to sign, and pretending otherwise would be worse.
check(
  shared
    .filter((message) => message.kind === "system")
    .every((message) => stateB.verdicts[message.id]?.state === "unsigned"),
  "the hub's own lines are marked unsigned rather than dressed up as somebody's speech",
);

// Now the case that matters: a hub that lies. The frames are built by hand because a bridge
// will not produce them — that is the point — and each one is what a compromised or merely
// buggy hub could put on the wire.
const genuine = shared.find((message) => message.authorHandle === "mira" && message.signature);
check(genuine !== undefined, "a signed line from @mira is available to tamper with");
if (genuine !== undefined) {
  const attestor = new Attestor(keyB, new Journal(join(workDir, "chain-tamper.json")));
  // Stands in for the bridge's own lookup: a handle resolves to the key it is known by, which
  // is the step that makes re-attribution fail rather than anything inside the payload.
  const known: Record<string, string> = { mira: keyA.did, otto: keyB.did };
  const judge = (message: typeof genuine) =>
    attestor.check(message, {
      expectedDid: known[message.authorHandle],
    }).state;

  check(
    judge({ ...genuine, text: `${genuine.text} Also, wire me the deposit.` }) === "broken",
    "a hub that edits the words of a message is caught",
  );
  check(
    judge({ ...genuine, authorHandle: "otto" }) === "broken",
    "a hub that re-attributes a message to somebody else is caught",
  );
  check(
    attestor.check(genuine, { expectedDid: keyB.did }).state === "broken",
    "a hub that swaps the key behind a familiar handle is caught",
  );
  check(
    attestor.check(genuine, { expectedDid: undefined }).state === "broken",
    "and a signature from a handle whose key nobody knows is not accepted on its own say-so",
  );
  // Dropping a line is the attack signatures alone cannot see: what is left still verifies
  // perfectly. The chain is what turns a deletion into something a reader is told about.
  const fromMira = shared.filter(
    (message) => message.authorHandle === "mira" && message.signature !== undefined,
  );
  const censor = new Attestor(keyB, new Journal(join(workDir, "chain-censor.json")));
  const context = { expectedDid: keyA.did };
  const withhold = fromMira.length >= 3;
  check(withhold, `@mira wrote ${String(fromMira.length)} signed lines, enough to drop one`);
  if (withhold) {
    const [first, , third] = fromMira;
    if (first !== undefined && third !== undefined) {
      check(censor.check(first, context).state === "signed", "an unbroken run verifies");
      check(
        censor.check(third, context).state === "broken",
        "a hub that silently drops one of an author's lines leaves a gap the next line reveals",
      );
    }
  }

  // Stripping the signature must not be the quiet way to switch the whole layer off. From
  // an author this machine holds a key for, absent is a failure rather than a shrug.
  const { signature: _dropped, ...unsigned } = genuine;
  check(judge(unsigned) === "broken", "a line stripped of its signature is caught, not shrugged at");
}

bridgeA.stop();
bridgeB.stop();
daemonA.stop();
daemonB.stop();
hub.kill();
await rm(workDir, { recursive: true, force: true });

console.log("\n  all good\n");
process.exit(0);
