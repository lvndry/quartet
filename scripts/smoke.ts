/**
 * @fileoverview Drives a whole conversation with two fake jazz daemons.
 *
 * A green unit suite says the pieces are individually plausible; this says the loop closes.
 * It runs a real hub process, two real bridges, and two stand-in daemons that answer the way
 * jazz's webhook door does — so the invite, the accept, the turn dispatch, the budget, the
 * pass, and the ledger are all exercised against the actual wire format rather than a mock
 * of it.
 *
 * Run with: bun scripts/smoke.ts
 */

import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "../packages/bridge/src/bridge";
import { setIdentityDirectory } from "../packages/bridge/src/paths";
import { readLedger } from "../packages/bridge/src/ledger";
import { CLOSE_SENTINEL, PASS_SENTINEL } from "../packages/protocol/src/index";
import {
  generateKeypair,
  generateSealingKeypair,
  linkAfter,
  newNonce,
  signChallenge,
  signClaim,
  signMessage,
  signSealingKey,
  unpackEnvelope,
  tag,
  type Keypair,
} from "../packages/identity/src/index";
import { Attestor } from "../packages/bridge/src/attest";
import { Sealer } from "../packages/bridge/src/sealer";
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
// Both, deliberately: the variable is for the hub, which is a separate process, and the
// call is for the bridges in this one. Setting only the variable used to leave this
// harness writing its ledgers into the operator's real ~/.quartet.
process.env["QUARTET_HOME"] = workDir;
setIdentityDirectory(workDir);

const hub = Bun.spawn({
  cmd: ["bun", "run", "packages/hub/src/main.ts"],
  env: {
    ...process.env,
    PORT: String(HUB_PORT),
    QUARTET_DB: join(workDir, "hub.sqlite"),
    // This run claims four handles and makes several deliberately bad claims, and every
    // request costs a token whether it is accepted or not. The real ceiling is exercised on
    // its own below rather than by letting it trip mid-scenario.
    QUARTET_REGISTRATION_BURST: "12",
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
// @nia and @ada are not needed until the room section far below, but they claim their
// handles here: the ceiling test just underneath drains the registration bucket on purpose,
// and it stays drained for the rest of the run.
const keyNia = generateKeypair();
const keyAda = generateKeypair();
await register("nia", keyNia);
await register("ada", keyAda);
check(keyA.did !== keyB.did, "two agents claimed handles with keys of their own");

// A handle is a name, not a slot. Two keys that have never met are both entitled to @sam,
// and what tells them apart is the fingerprint in their tags. See docs/design/identity.md.
const keySam = generateKeypair();
const keyOtherSam = generateKeypair();
const firstSam = await claim("sam", keySam);
const secondSam = await claim("sam", keyOtherSam);
check(firstSam.status === 201 && secondSam.status === 201, "two keys may wear the same handle");
const sams = await Promise.all(
  [firstSam, secondSam].map(async (response) => (await response.json()) as { agent: { did: string } }),
);
const samTags = sams.map((body) => tag("sam", body.agent.did));
check(
  samTags[0] !== undefined && samTags[0] !== samTags[1],
  "and are told apart by their tags, not by the name they share",
);
// The tag is the unique thing, and a key that has already claimed cannot claim again — which
// is the only way two rows could ever come to wear one.
const repeatSam = await claim("sam", keySam);
const repeatReason = ((await repeatSam.json()) as { error?: string }).error ?? "";
check(
  repeatSam.status === 409 && repeatReason.includes("already claimed"),
  "a key claiming twice is refused, so no two agents can carry the same tag",
);
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
  new Sealer({ current: generateSealingKeypair(), retired: [] }),
  // Two bridges in one process, so each is pointed at its own pin file — on a real host
  // these are two data directories and the default would already be separate.
  new KnownKeys(join(workDir, "known-mira.json")),
);
const bridgeB = new Bridge(
  hubUrl,
  { url: `http://127.0.0.1:${String(DAEMON_B_PORT)}`, webhook: "quartet", token: "test-token" },
  new Attestor(keyB, new Journal(join(workDir, "chain-otto.json"))),
  new Sealer({ current: generateSealingKeypair(), retired: [] }),
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
check(
  stateB.invites[0]?.fromDid === keyA.did && stateB.invites[0].purpose === PURPOSE,
  "the invite reached @otto with its purpose line, naming its sender by key",
);
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
      messages.some((message) => message.authorDid === keyA.did && message.kind === "agent") &&
      messages.some((message) => message.authorDid === keyB.did && message.kind === "agent") &&
      messages.some((message) => message.kind === "pass")
    );
  },
  30_000,
  () => stateA.messages[conversationId]?.map((message) => `${message.authorDid}:${message.kind}`),
);

/**
 * The words behind a line, the way the app reads them.
 *
 * Off the snapshot's `opened` map and never off `message.text`, which is the envelope the
 * author signed and the hub relayed. A test that read the message directly would compare
 * against ciphertext and pass by accident on every assertion phrased as a negative.
 */
const words = (state: typeof stateA, message: { id: string }): string | undefined => {
  const read = state.opened[message.id];
  return read?.state === "opened" ? read.text : undefined;
};

const transcript = stateA.messages[conversationId] ?? [];
check(transcript.length > 1, `the agents exchanged ${String(transcript.length)} messages`);
check(
  !transcript.some((message) => message.kind === "agent" && words(stateA, message) === PURPOSE),
  "the purpose was a steer, not an agent utterance in the room",
);
check(
  transcript.some((message) => message.kind === "pass"),
  "a pass was recorded as silence rather than as a message",
);
const firstCall = daemonA.calls[0] as {
  body: { transcript: unknown[]; purpose?: string; steer?: string };
};
check(
  firstCall?.body.purpose === PURPOSE,
  "the inviter's agent opened the room knowing what it was for",
);
// A steer is the field the agent is told to obey ahead of the room, and only an owner's own
// bridge can write one — it arrives sealed to a key the hub does not hold. So the hub starting
// a conversation must not look like the owner speaking, however convenient the purpose is.
check(
  firstCall?.body.steer === undefined,
  "and the hub did not put its own words in the owner's mouth to do it",
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
  !(stateB.messages[conversationId] ?? []).some(
    (message) =>
      message.text.includes("rue Oberkampf") ||
      (words(stateB, message) ?? "").includes("rue Oberkampf"),
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
    (stateA.messages[conversationId] ?? []).at(-1)?.authorDid !== keyA.did ||
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
  ledger.every((entry) => settled.some((message) => words(stateA, message) === entry.text)),
  "every ledger entry corresponds to something that actually crossed",
);
check(
  settled
    .filter((message) => message.kind === "agent" && message.authorDid === keyA.did)
    .every((message) => ledger.some((entry) => entry.text === words(stateA, message))),
  "and nothing @mira said is missing from the ledger",
);

// The claim the sealing layer makes, asserted against the hub's actual database rather than
// against the wire format. Everything above proves the words reached the far side; this
// proves they did not stay behind. A hub operator with root on this machine, reading the file
// the hub writes, finds envelopes.
{
  const stored = new Database(join(workDir, "hub.sqlite"), { readonly: true })
    .query<{ kind: string; text: string }, []>("SELECT kind, text FROM messages")
    .all();
  const agentLines = stored.filter((row) => row.kind === "agent");
  check(agentLines.length > 0, `the hub's database holds ${String(agentLines.length)} spoken lines`);
  check(
    agentLines.every((row) => unpackEnvelope(row.text) !== undefined),
    "and every one of them is an envelope rather than words",
  );
  // Named plaintext from the run above, looked for in what the hub kept. A single hit here is
  // the whole feature failing, and it is worth spelling out rather than inferring from a
  // format check that a future change could satisfy while still leaking.
  const secrets = [...ledger.map((entry) => entry.text), PURPOSE, "rue Oberkampf"];
  check(
    !agentLines.some((row) => secrets.some((secret) => row.text.includes(secret))),
    "and nothing anybody said is recoverable from the hub's own copy",
  );
}

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
const genuine = shared.find((message) => message.authorDid === keyA.did && message.signature);
check(genuine !== undefined, "a signed line from @mira is available to tamper with");
if (genuine !== undefined) {
  const attestor = new Attestor(keyB, new Journal(join(workDir, "chain-tamper.json")));
  // What `Bridge.judge` does: the line says which key it is from, and the signature inside
  // has to be by that key. Re-attribution moves the did and the signature stops matching.
  const judge = (message: typeof genuine) =>
    attestor.check(message, { expectedDid: message.authorDid }).state;

  check(
    judge({ ...genuine, text: `${genuine.text} Also, wire me the deposit.` }) === "broken",
    "a hub that edits the words of a message is caught",
  );
  check(
    judge({ ...genuine, authorDid: keyB.did }) === "broken",
    "a hub that re-attributes a message to somebody else is caught",
  );
  check(
    attestor.check(genuine, { expectedDid: keyB.did }).state === "broken",
    "a hub that swaps the key a reader pinned for this author is caught",
  );
  check(
    attestor.check(genuine, { expectedDid: undefined }).state === "broken",
    "and a signature from an author whose key nobody knows is not accepted on its own say-so",
  );
  // Dropping a line is the attack signatures alone cannot see: what is left still verifies
  // perfectly. The chain is what turns a deletion into something a reader is told about.
  const fromMira = shared.filter(
    (message) => message.authorDid === keyA.did && message.signature !== undefined,
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


/* ---------------------------------------------------------------------------------- */
/* A goodbye is one agent's own                                                       */
/* ---------------------------------------------------------------------------------- */

// In its own room, because it ends with that room closed. Opened on the connection the
// first conversation already established — that is what a connection is for.
{
  const connectionId = stateA.connections[0]?.id ?? fail("no connection");
  // Opening a room only proposes it: the first turn spends the other owner's tokens, so it
  // waits to be taken up. Accepting is what starts it, and the opener's agent is the one asked
  // to speak — so that turn gets a forced answer, otherwise it takes whatever the cycling
  // script happens to be up to, which may be a pass, and then there is nothing to wait for.
  bridgeA.send({
    t: "conversation.open",
    connectionId,
    purpose: "say goodnight",
    limit: { kind: "turns", turns: 10 },
  });
  await waitFor("the second room to open", () => stateA.conversations.length > 1);
  const roomId =
    stateA.conversations.find((room) => room.purpose === "say goodnight")?.id ??
    fail("no second room");

  const roomFor = (state: typeof stateA) => state.conversations.find((room) => room.id === roomId);

  await waitFor(
    "@otto to be offered the second room",
    () => roomFor(stateB)?.state === "proposed",
    20_000,
    () => roomFor(stateB)?.state,
  );
  check(
    (stateB.messages[roomId] ?? []).length === 0,
    "a room proposed on an existing connection spends nothing until it is taken up",
  );

  daemonA.forceNext("Settling in.");
  bridgeB.send({ t: "conversation.respond", conversationId: roomId, accept: true });
  await waitFor(
    "the opening turn to settle",
    () => (stateA.messages[roomId] ?? []).some((message) => words(stateA, message) === "Settling in."),
    20_000,
  );
  await Bun.sleep(800);

  daemonA.forceNext(`Goodnight then. ${CLOSE_SENTINEL}`);
  bridgeA.nudge(roomId, "wrap it up");
  await waitFor(
    "@mira's agent to bow out",
    () => (roomFor(stateB)?.bowedOut ?? []).includes(keyA.did),
    20_000,
    () => roomFor(stateB)?.bowedOut,
  );
  check(
    roomFor(stateB)?.state === "live",
    "one agent's goodbye takes it out of the room without closing the room",
  );
  check(
    (roomFor(stateA)?.bowedOut ?? []).includes(keyA.did),
    "and both sides are told which agent has gone",
  );

  // Nothing @otto says may put @mira's agent back to work — only @mira can.
  const miraTurnsBefore = daemonA.calls.length;
  daemonB.forceNext("Are you still there?");
  bridgeB.nudge(roomId, "ask if they are still awake");
  await waitFor(
    "@otto's agent to answer into the room",
    () =>
      (stateB.messages[roomId] ?? []).some(
        (message) => words(stateB, message) === "Are you still there?",
      ),
    20_000,
  );
  await Bun.sleep(1200);
  check(
    daemonA.calls.length === miraTurnsBefore,
    "a peer talking does not wake an agent that has said goodbye",
  );

  daemonB.forceNext(`Goodnight. ${CLOSE_SENTINEL}`);
  bridgeB.nudge(roomId, "you turn in too");
  await waitFor(
    "the room to close behind the last of them",
    () => roomFor(stateA)?.state === "closed",
    20_000,
    () => roomFor(stateA)?.state,
  );
  check(
    roomFor(stateA)?.state === "closed" && (roomFor(stateA)?.bowedOut ?? []).length === 2,
    "and the room closes once every agent has gone",
  );
}

/* ---------------------------------------------------------------------------------- */
/* A room is not a pair                                                               */
/* ---------------------------------------------------------------------------------- */

/**
 * A third party on a bare socket, no bridge and no daemon.
 *
 * What is on trial in this section is the hub's frame handlers — who may join a room, who a
 * message wakes, what happens as people leave. None of that needs a model behind it, and a
 * socket speaking the protocol directly is the shortest way to ask. @mira and @otto are
 * still real bridges, so the membership change has to reach those too.
 */
class Party {
  readonly frames: { t: string; [key: string]: unknown }[] = [];
  private socket!: WebSocket;
  /** This party's own signing chain, one link per room. */
  private readonly chain = new Map<string, string>();
  /**
   * Set to keep the next turn instead of passing on it.
   *
   * Everything a turn produces has to name the dispatch that turn was given, so a party
   * that has already settled every turn it was offered cannot exercise any of those frames.
   */
  holdNextTurn = false;
  /** The dispatch of a turn this party is deliberately sitting on. */
  heldDispatch: string | undefined;

  constructor(
    readonly handle: string,
    private readonly keypair: Keypair,
  ) {}

  async join(): Promise<void> {
    this.socket = new WebSocket(`${hubUrl.replace("http", "ws")}/socket`);
    // Listening before the open await, because the hub challenges the moment the socket is
    // up and a listener attached afterwards can miss it.
    const answered = new Promise<void>((resolve) => {
      this.socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as {
          t: string;
          conversationId?: string;
          dispatch?: string;
          nonce?: string;
        };
        this.frames.push(frame);
        if (frame.t === "challenge" && frame.nonce !== undefined) {
          const at = new Date().toISOString();
          const { sealingDid } = generateSealingKeypair();
          this.send({
            t: "hello",
            did: this.keypair.did,
            challenge: frame.nonce,
            signature: signChallenge(this.keypair.did, frame.nonce, this.keypair.privateKey),
            // A stand-in bridge still publishes a real, signed sealing key: the other side
            // refuses to speak into a room holding a member it cannot seal to, so a party
            // without one would silence everybody else rather than only itself.
            sealing: {
              sealingDid,
              at,
              proof: signSealingKey(
                { did: this.keypair.did, sealingDid, at },
                this.keypair.privateKey,
              ),
            },
          });
          resolve();
          return;
        }
        // Answer every turn, with nothing. One turn is in flight per agent at a time, so a
        // party that took its turn and never settled it would quietly stop being dispatched
        // to — and every later assertion about being woken would fail for that reason rather
        // than the one it was testing. A pass is the cheapest way to be well behaved.
        if (frame.t === "turn" && frame.conversationId !== undefined && frame.dispatch !== undefined) {
          if (this.holdNextTurn) {
            this.holdNextTurn = false;
            this.heldDispatch = frame.dispatch;
            return;
          }
          this.pass(frame.conversationId, frame.dispatch);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error(`@${this.handle} could not connect`)));
    });
    await answered;
    cleanups.push(() => this.socket.close());
  }

  /**
   * A pass is this agent's silence, so the hub wants it signed like speech — and named, so
   * the hub can see it answers a turn it actually handed out.
   */
  private pass(conversationId: string, dispatch: string): void {
    const authoredAt = new Date().toISOString();
    const nonce = newNonce();
    const prev = this.chain.get(conversationId) ?? "";
    const signature = signMessage(
      { did: this.keypair.did, conversationId, kind: "pass", authoredAt, nonce, prev, dispatch, text: "" },
      this.keypair.privateKey,
    );
    this.chain.set(conversationId, linkAfter(signature));
    this.send({
      t: "pass",
      conversationId,
      dispatch,
      authorship: { authoredAt, nonce, prev, signature },
    });
  }

  /** Settle a turn this party was sitting on. */
  passHeld(conversationId: string): void {
    const dispatch = this.heldDispatch;
    if (dispatch === undefined) return;
    this.heldDispatch = undefined;
    this.pass(conversationId, dispatch);
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  last<T>(kind: string): T | undefined {
    return [...this.frames].reverse().find((frame) => frame.t === kind) as T | undefined;
  }

  count(kind: string): number {
    return this.frames.filter((frame) => frame.t === kind).length;
  }
}

// @nia is connected to @mira but has never met @otto. @ada is connected to nobody.
const nia = new Party("nia", keyNia);
const ada = new Party("ada", keyAda);
await nia.join();
await ada.join();

bridgeA.send({ t: "invite.send", toDid: keyNia.did, purpose: "sanity-check the venue", limit: { kind: "turns", turns: 20 } });
await waitFor("the invite to reach @nia", () => nia.count("invite") > 0);
const niaInvite = nia.last<{ invite: { id: string } }>("invite");
nia.send({ t: "invite.respond", inviteId: niaInvite?.invite.id ?? "", accept: true });
await waitFor("@nia to be connected", () => nia.count("connected") > 0);

const niaTurnsBeforeJoining = nia.count("turn");
bridgeA.send({ t: "conversation.add", conversationId, did: keyNia.did });
await waitFor(
  "the room to grow",
  () => (stateB.conversations.find((room) => room.id === conversationId)?.participants.length ?? 0) === 3,
  10_000,
  () => stateB.conversations.find((room) => room.id === conversationId)?.participants,
);
check(
  (stateB.conversations.find((room) => room.id === conversationId)?.participants ?? []).some(
    (member) => member.handle === "nia",
  ),
  "a third agent can be brought into a room over the wire",
);
check(
  nia.count("welcome") === 2,
  "and is sent the room and the history it missed, without asking for it",
);
const niaSees = nia.last<{ others: { did: string }[] }>("presence")?.others ?? [];
check(
  niaSees.map((entry) => entry.did).sort().join(",") ===
    [keyA.did, keyB.did].sort().join(","),
  "presence names both of the others by key, including the one @nia had never met",
);
check(
  nia.count("turn") > niaTurnsBeforeJoining,
  "the newcomer is asked for a turn, having heard none of it",
);

// The rule the whole introduction model rests on: a connection is where somebody agreed to
// talk to you, and knowing a handle is not a substitute for having one.
ada.send({ t: "conversation.add", conversationId, did: keyA.did });
await waitFor("@ada to be refused", () => ada.count("error") > 0);
check(
  String(ada.last<{ detail: string }>("error")?.detail ?? "").includes("not in that conversation"),
  "somebody outside a room cannot add to it",
);
nia.send({ t: "conversation.add", conversationId, did: keyAda.did });
await waitFor("the unconnected add to be refused", () => nia.count("error") > 0);
check(
  String(nia.last<{ detail: string }>("error")?.detail ?? "").includes("not connected"),
  "and @ada cannot be brought in by somebody who has never been introduced to her",
);

// One message, three agents: the two who did not speak are both woken, and the speaker is
// not asked to answer itself.
const beforeSay = { otto: daemonB.calls.length, nia: nia.count("turn") };
bridgeA.nudge(conversationId, "confirm the venue with both of them");
await waitFor(
  "both of the others to be asked for a turn",
  () => daemonB.calls.length > beforeSay.otto && nia.count("turn") > beforeSay.nia,
  20_000,
  () => ({ otto: daemonB.calls.length - beforeSay.otto, nia: nia.count("turn") - beforeSay.nia }),
);
check(
  daemonB.calls.length > beforeSay.otto && nia.count("turn") > beforeSay.nia,
  "a message in a room of three wakes both of the others",
);

// A heartbeat is accepted for a turn you are actually holding, and refused otherwise. This
// is the frame that stops the hub reading a slow turn as a dead bridge, so the wire path for
// it matters as much as the timer that drives it — and it is also a line in somebody else's
// room ("their agent is reading your calendar"), so an agent with no turn has no business
// putting one there.
const errorsBefore = nia.count("error");
nia.holdNextTurn = true;
// @nia asks her own agent for a turn rather than waiting for one of the others to say
// something. A steer reaches its own agent directly and tops up an allowance that has run
// out, so this does not depend on where the cycling daemons happen to have got to — and the
// room is out of turns by this point, which is exactly when waiting on a cascade is a race.
nia.send({ t: "nudge", conversationId, steer: "hold on, checking something" });
await waitFor(
  "@nia to be given a turn she can sit on",
  () => nia.heldDispatch !== undefined,
  20_000,
  () => ({
    niaTurns: nia.count("turn"),
    lastNiaError: nia.last<{ detail: string }>("error")?.detail,
    room: stateB.conversations.find((room) => room.id === conversationId),
  }),
);
nia.send({ t: "progress", conversationId, dispatch: nia.heldDispatch });
await Bun.sleep(600);
check(
  nia.count("error") === errorsBefore,
  "a heartbeat for a turn the hub is holding for you is accepted",
);

nia.send({ t: "progress", conversationId, dispatch: "a-turn-nobody-gave-out" });
await waitFor("the invented turn to be refused", () => nia.count("error") > errorsBefore);
check(
  String(nia.last<{ detail: string }>("error")?.detail ?? "").includes("not holding that turn"),
  "and a heartbeat naming a turn nobody was given is not",
);

const adaErrorsBefore = ada.count("error");
ada.send({ t: "progress", conversationId, dispatch: nia.heldDispatch ?? "x" });
await waitFor("the outsider's heartbeat to be refused", () => ada.count("error") > adaErrorsBefore);
check(
  String(ada.last<{ detail: string }>("error")?.detail ?? "").includes("not in that conversation"),
  "and one from outside the room is refused before the turn is even looked at",
);

// Tidy up: one turn in flight per agent, so a turn sat on forever would quietly stop @nia
// being dispatched to and every later assertion would fail for that reason instead of its own.
nia.passHeld(conversationId);

nia.send({ t: "conversation.leave", conversationId });
await waitFor(
  "the room to shrink",
  () => (stateB.conversations.find((room) => room.id === conversationId)?.participants.length ?? 0) === 2,
  10_000,
);
check(
  stateB.conversations.find((room) => room.id === conversationId)?.state === "live",
  "somebody walking out of a room of three leaves it running",
);

bridgeA.send({ t: "conversation.leave", conversationId });
await waitFor(
  "the room to close behind the last of them",
  () => stateB.conversations.find((room) => room.id === conversationId)?.state === "closed",
  10_000,
  () => stateB.conversations.find((room) => room.id === conversationId)?.state,
);
check(
  stateB.conversations.find((room) => room.id === conversationId)?.state === "closed",
  "and the last one out closes it rather than leaving an agent talking to nobody",
);

bridgeA.stop();
bridgeB.stop();
daemonA.stop();
daemonB.stop();
hub.kill();
await rm(workDir, { recursive: true, force: true });

console.log("\n  all good\n");
process.exit(0);
