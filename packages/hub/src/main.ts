/**
 * @fileoverview The hub: a socket router with a database, and nothing else.
 *
 * No model keys, no model calls, no ledgers. `docs/design/architecture.md` says why that is the
 * architecture rather than a stage it is passing through, and §6 covers what this file
 * defends against on a public instance.
 */

import { Hono } from "hono";
import type { ServerWebSocket } from "bun";
import {
  describeFrameRejection,
  handleSchema,
  HISTORY_PAGE_SIZE,
  MAX_ROOM_MEMBERS,
  parseClientFrame,
  type Agent,
  type Authorship,
  type DirectoryEntry,
  type MessageKind,
  type ServerFrame,
  type Signature,
} from "@quartet/protocol";
import { isDid, newNonce, verifyChallenge, verifyClaim, verifyMessage } from "@quartet/identity";
import { HubStore, type AgentRow } from "./db";
import { Orchestrator, type Accepted } from "./orchestrator";
import { RoomPresence } from "./presence";
import { RateLimiter } from "./rate-limit";
import { startTunnel } from "@quartet/tunnel";

const PORT = Number(process.env["PORT"] ?? 8080);
const DB_PATH = process.env["QUARTET_DB"] ?? "quartet.sqlite";

/**
 * Which interface to listen on. Loopback unless somebody says otherwise.
 *
 * The default used to be every interface, so `bun run hub` put an unencrypted socket carrying
 * every conversation on the machine's whole network. `--tunnel` is the intended way to be
 * reachable, and it terminates TLS in front.
 */
const HOST = process.env["QUARTET_HOST"] ?? "127.0.0.1";

/**
 * TLS, if this hub terminates it itself.
 *
 * Optional because a tunnel or a reverse proxy terminates it in front. What is not optional
 * is that one of the three is true — see the refusal below.
 */
const TLS_CERT = process.env["QUARTET_TLS_CERT"];
const TLS_KEY = process.env["QUARTET_TLS_KEY"];

/**
 * Whether this hub terminates TLS itself. One answer, asked in all three places that care:
 * the refusal below, the serve config, and the scheme printed at boot. A cert without its key
 * used to satisfy the refusal and print `https` while serving plaintext.
 */
const SERVES_TLS = TLS_CERT !== undefined && TLS_KEY !== undefined;

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "[::1]";
}

/**
 * Refuse to serve conversations in the clear to a network.
 *
 * Signatures mean a middlebox cannot *change* a line without being caught, and do nothing
 * about reading it. A refusal rather than a warning, because a warning at boot is a warning
 * nobody reads and the failure it precedes is silent.
 */
if (!isLoopback(HOST) && !SERVES_TLS && process.env["QUARTET_ALLOW_PLAINTEXT"] !== "1") {
  console.error(
    `\n  refusing to listen on ${HOST} without TLS.\n\n` +
      "  Every frame would cross the network readable, conversations included.\n" +
      "  Pick one:\n" +
      "    • run `bun run hub -- --tunnel` and leave QUARTET_HOST alone (cloudflared\n" +
      "      terminates TLS and reaches this hub over loopback)\n" +
      "    • set QUARTET_TLS_CERT and QUARTET_TLS_KEY to serve https/wss here\n" +
      "    • set QUARTET_ALLOW_PLAINTEXT=1 if a reverse proxy in front already\n" +
      "      terminates TLS and only it can reach this port\n",
  );
  process.exit(1);
}

/**
 * What a public socket may do, before anything it says is read. See `docs/design/hub-door.md`.
 *
 * `MAX_FRAME_BYTES` is sized against the largest legitimate frame: a `say` is capped at
 * 10,000 characters, which JSON escaping can quadruple. The rate pair lets a reconnecting
 * bridge flush its queue and then settle far above anything a turn produces.
 */
const MAX_FRAME_BYTES = 128 * 1024;
const FRAME_BURST = 120;
const FRAME_REFILL_MS = 250;
// Overridable only so the hardening tests do not have to wait ten seconds to watch a socket
// that never introduces itself get closed.
const HELLO_GRACE_MS = Number(process.env["QUARTET_HELLO_GRACE_MS"] ?? 10_000);
const MAX_SOCKETS = Number(process.env["QUARTET_MAX_SOCKETS"] ?? 512);
const MAX_ANONYMOUS_PER_ADDRESS = 8;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/**
 * How long a socket may say nothing before the hub treats it as gone.
 *
 * Four times the bridge's keepalive interval, so three lost pings in a row is survivable and
 * a network hiccup does not read as a departure.
 */
const SOCKET_IDLE_TIMEOUT_S = 120;
/** A label for `/join`, so an invite link says what somebody is joining rather than just a URL. */
const HUB_NAME = (() => {
  const index = process.argv.indexOf("--name");
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : "a quartet hub";
})();

const store = new HubStore(DB_PATH);

/** Live bridges, by agent. Presence in quartet is exactly "your bridge is connected". */
const sockets = new Map<string, ServerWebSocket<SocketData>>();

/** Every open socket, authenticated or not, so the process-wide ceiling is countable. */
const openSockets = new Set<ServerWebSocket<SocketData>>();

/** Unauthenticated sockets per peer address — the ones that cost nothing to open. */
const anonymous = new Map<string, number>();

/** Keyed per socket, not per agent: an unauthenticated socket has no agent, and that is the
 * one worth limiting. */
const frameRate = new RateLimiter({ burst: FRAME_BURST, refillMs: FRAME_REFILL_MS });

interface SocketData {
  agentId?: string;
  /** Issued when the socket opens; the only string a hello on this socket may answer. */
  challenge?: string;
  /** This socket's own name, for the frame allowance. Not an identity. */
  id: string;
  /** The peer address, kept so the anonymous count can be given back on close. */
  address: string;
  /** Fires if the socket has not said who it is. Cleared by a successful hello. */
  helloBy?: ReturnType<typeof setTimeout>;
}

function countAnonymous(address: string, delta: number): void {
  const next = (anonymous.get(address) ?? 0) + delta;
  if (next <= 0) anonymous.delete(address);
  else anonymous.set(address, next);
}

/** A socket stops being anonymous exactly once, whether it authenticates or goes away. */
function noLongerAnonymous(socket: ServerWebSocket<SocketData>): void {
  if (socket.data.helloBy === undefined) return;
  clearTimeout(socket.data.helloBy);
  delete socket.data.helloBy;
  countAnonymous(socket.data.address, -1);
}

function isOnline(agentId: string): boolean {
  return sockets.has(agentId);
}

/** A handle for the logs, falling back to the id for an agent the store no longer has. */
function describeAgent(agentId: string): string {
  const handle = store.agentById(agentId)?.handle;
  return handle === undefined ? agentId : `@${handle}`;
}

/**
 * Send one frame, or drop a socket that has stopped reading.
 *
 * A peer that has stopped draining is a queue the hub grows on its behalf. Closing it is
 * survivable where running out of memory is not: a bridge reconnects, and `replayTurns` hands
 * back what it was owed.
 */
function send(agentId: string, frame: ServerFrame): void {
  const socket = sockets.get(agentId);
  if (socket === undefined) return;
  if (socket.getBufferedAmount() > MAX_BUFFERED_BYTES) {
    console.warn(`dropping a socket that stopped reading: ${agentId}`);
    socket.close(1013, "too far behind");
    return;
  }
  socket.send(JSON.stringify(frame));
}

let presence!: RoomPresence;
const orchestrator = new Orchestrator(store, send, isOnline, (conversationId) =>
  presence.announce(conversationId),
);
presence = new RoomPresence(store, send, isOnline, (conversationId, agentId) =>
  orchestrator.hasTurn(conversationId, agentId),
);

function agentView(agentId: string): Agent | undefined {
  const row = store.agentById(agentId);
  return row ? store.toAgent(row, isOnline(agentId)) : undefined;
}

/**
 * Everyone currently online here, plus every contact of theirs whether online or not.
 *
 * Bounded by who is around rather than by how long the hub has existed, which is what a list
 * of every agent ever registered was not. A connection stays visible regardless, so stepping
 * offline does not make you disappear from somebody who already knows you.
 */
function directoryFor(agentId: string): DirectoryEntry[] {
  const connected = new Set(store.connectionsFor(agentId).map((connection) => connection.other));
  const pending = new Set(
    store
      .pendingInvitesFor(agentId)
      .flatMap((invite) => [invite.fromHandle, invite.toHandle]),
  );
  return store
    .allAgents()
    .filter((row) => row.id !== agentId)
    .filter((row) => isOnline(row.id) || connected.has(row.id) || pending.has(row.handle))
    .map((row) => ({
      agent: store.toAgent(row, isOnline(row.id)),
      connected: connected.has(row.id),
      invitePending: pending.has(row.handle),
    }));
}

function sendWelcome(agentId: string): void {
  const me = agentView(agentId);
  if (me === undefined) return;
  const connections = store
    .connectionsFor(agentId)
    .flatMap((connection) => {
      const view = store.toConnection(connection.id, connection.other, connection.created_at, isOnline);
      return view ? [view] : [];
    });
  send(agentId, {
    t: "welcome",
    me,
    connections,
    conversations: store.conversationsFor(agentId),
    invites: store.pendingInvitesFor(agentId),
    messages: store.messagesForAgent(agentId),
  });
}

/**
 * Tell everyone who can see this agent that its presence changed — currently everyone.
 *
 * O(online²) per connect. Needs scoping to connections plus a search endpoint long before the
 * directory is worth scrolling.
 */
function broadcastPresence(): void {
  for (const [agentId] of sockets) {
    send(agentId, { t: "directory", people: directoryFor(agentId) });
  }
}

/**
 * How many identities one address may claim: a roomful at once, then one every twenty minutes.
 *
 * The burst is `MAX_ROOM_MEMBERS` because a full room on one machine is a legitimate thing to
 * stand up in one go. What stops a namespace being taken is the refill rate, not the burst.
 *
 * `QUARTET_REGISTRATION_BURST` raises it for the test harnesses, which mint a cast of agents
 * against a throwaway hub and should not have to fit inside a rule aimed at the internet.
 */
const registrations = new RateLimiter({
  burst: Number(process.env["QUARTET_REGISTRATION_BURST"] ?? MAX_ROOM_MEMBERS),
  refillMs: 20 * 60_000,
});

/** `ip` is filled in from the socket by the server below, because Hono cannot see it. */
const app = new Hono<{ Bindings: { ip: string } }>();

app.get("/health", (context) => context.json({ ok: true }));

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === '"' ? "&quot;" : "&#39;",
  );
}

/**
 * A page for a link, not a URL for a CLI flag.
 *
 * A tunnel URL means nothing pasted bare, so this gives whoever clicks it the one command to
 * run with the origin filled in. Read off the request, so it works through a tunnel and on
 * localhost identically.
 */
app.get("/join", (context) => {
  const origin = new URL(context.req.url).origin;
  const command = `bun run bridge connect --hub ${origin}`;
  const name = escapeHtml(HUB_NAME);
  return context.html(
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<title>Join ${name}</title>` +
      `<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.5rem;line-height:1.5}` +
      `code{background:#eee;padding:0.6rem 0.8rem;border-radius:6px;display:block;overflow-x:auto}` +
      `button{margin-top:0.6rem;padding:0.4rem 0.9rem;cursor:pointer}</style></head><body>` +
      `<h1>${name}</h1>` +
      `<p>Somebody is inviting you to a <a href="https://github.com/lvndry/quartet">quartet</a> hub. ` +
      `Run this to join:</p>` +
      `<code id="cmd">${escapeHtml(command)}</code>` +
      `<button onclick="navigator.clipboard.writeText(document.getElementById('cmd').textContent)">Copy</button>` +
      `</body></html>`,
  );
});

/**
 * How far out of step a claiming machine's clock may be.
 *
 * Stops a claim overheard on the wire being replayed at leisure. Minutes rather than seconds
 * because the cost of strictness falls on the honest user with a drifting laptop clock.
 */
const CLAIM_WINDOW_MS = 10 * 60 * 1000;

function withinClaimWindow(at: string): boolean {
  const claimed = Date.parse(at);
  return Number.isFinite(claimed) && Math.abs(Date.now() - claimed) < CLAIM_WINDOW_MS;
}

/**
 * Claim a handle. See `docs/design/identity.md`.
 *
 * Nothing secret comes back: the key is the credential and it never left the machine that
 * made it, so there is no token here to leak, lose or rotate.
 */
app.post("/agents", async (context) => {
  // Charged before the body is even read, so a flood of malformed requests costs the same
  // as a flood of valid ones.
  const verdict = registrations.take(context.env.ip);
  if (!verdict.allowed) {
    const seconds = Math.ceil(verdict.retryAfterMs / 1000);
    return context.json(
      { error: `too many handles claimed from here — try again in ${String(seconds)}s` },
      429,
      { "retry-after": String(seconds) },
    );
  }

  const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return context.json({ error: "expected a JSON body" }, 400);

  const handle = handleSchema.safeParse(body["handle"]);
  if (!handle.success) {
    return context.json({ error: handle.error.issues[0]?.message ?? "invalid handle" }, 400);
  }
  const displayName = typeof body["displayName"] === "string" ? body["displayName"].trim() : "";
  if (displayName.length === 0) return context.json({ error: "displayName is required" }, 400);

  const did = typeof body["did"] === "string" ? body["did"] : undefined;
  const signature = typeof body["signature"] === "string" ? body["signature"] : undefined;
  const claimedAt = typeof body["at"] === "string" ? body["at"] : undefined;
  if (did === undefined || signature === undefined || claimedAt === undefined) {
    return context.json({ error: "a claim needs a did, an at, and a signature" }, 400);
  }
  if (!isDid(did)) return context.json({ error: "that did is not an Ed25519 did:key" }, 400);
  if (!withinClaimWindow(claimedAt)) {
    return context.json({ error: "that claim is stale — check this machine's clock" }, 400);
  }
  if (!verifyClaim({ did, handle: handle.data, at: claimedAt }, signature)) {
    return context.json({ error: "that signature does not match the did" }, 401);
  }

  const created = store.createAgent({
    handle: handle.data,
    displayName,
    ...(typeof body["bio"] === "string" ? { bio: body["bio"] } : {}),
    did,
  });
  if (created === undefined) {
    const taken = store.agentByDid(did) !== undefined;
    return context.json(
      { error: taken ? "that key already claimed a handle" : "that handle is taken" },
      409,
    );
  }

  return context.json({ agent: store.toAgent(created, false) }, 201);
});

/**
 * Check a signature the hub is about to store and repeat, and turn it into what gets stored.
 *
 * The far side checks it again on arrival, which is the check that counts. This exists so a
 * broken signature is refused at the door rather than travelling to somebody else's screen to
 * be reported as an untrustworthy correspondent. Undefined means refuse.
 */
function signatureFor(
  author: AgentRow,
  authorship: Authorship,
  covered: { conversationId: string; kind: MessageKind; dispatch: string; text: string },
): Signature | undefined {
  // An agent that never presented a key cannot start signing mid-life: its did is what the
  // other side pinned, and accepting a fresh one here would be the hub swapping somebody's
  // key, which is exactly the move all of this exists to make impossible.
  const did = author.did;
  if (did === null) return undefined;

  const signature: Signature = {
    did,
    authoredAt: authorship.authoredAt,
    nonce: authorship.nonce,
    prev: authorship.prev,
    dispatch: covered.dispatch,
    value: authorship.signature,
  };

  const ok = verifyMessage(
    {
      did,
      conversationId: covered.conversationId,
      kind: covered.kind,
      authoredAt: authorship.authoredAt,
      nonce: authorship.nonce,
      prev: authorship.prev,
      dispatch: covered.dispatch,
      text: covered.text,
    },
    authorship.signature,
  );
  return ok ? signature : undefined;
}

/**
 * Check what an agent signed, or refuse the frame and say why.
 *
 * No third answer: every connected bridge can sign, so a line without a good signature is
 * skew or an attempt, and neither should be relayed as merely unverifiable.
 */
function signedOrRefused(
  author: AgentRow | undefined,
  authorship: Authorship,
  agentId: string,
  check: (author: AgentRow, authorship: Authorship) => Signature | undefined,
): Signature | undefined {
  const signature = author === undefined ? undefined : check(author, authorship);
  if (signature === undefined) {
    send(agentId, { t: "error", detail: "that signature does not check out against your did" });
    return undefined;
  }
  return signature;
}

/** Everyone in a room this agent is actually in, or nothing and a refusal. */
function roomFor(agentId: string, conversationId: string): string[] | undefined {
  const participants = store.conversationParticipantIds(conversationId);
  if (participants === undefined || !participants.includes(agentId)) {
    send(agentId, { t: "error", detail: "you are not in that conversation" });
    return undefined;
  }
  return participants;
}

/**
 * Whether this agent currently holds the floor in this room, under this dispatch.
 *
 * The check membership and a signature together cannot make: both establish *who* is talking,
 * neither establishes that the room ever asked. See `docs/design/turns.md`.
 */
function holdsTheFloor(agentId: string, conversationId: string, dispatch: string): boolean {
  switch (store.dispatchState(conversationId, agentId, dispatch)) {
    case "open":
      return true;
    case "settled":
      send(agentId, { t: "error", detail: "that turn has already been answered" });
      return false;
    default:
      send(agentId, {
        t: "error",
        detail:
          "the hub is not holding that turn for you — an agent speaks when it is dispatched a " +
          "turn, and only once per dispatch",
      });
      return false;
  }
}

/**
 * Whether this author has already used this nonce in this room.
 *
 * The unique index in the database is the enforcement; this is here so the answer is a
 * sentence rather than a crash.
 */
function usedBefore(agentId: string, conversationId: string, signature: Signature): boolean {
  if (!store.nonceUsed(conversationId, signature.did, signature.nonce)) return false;
  send(agentId, {
    t: "error",
    detail: "that line has already been recorded — a nonce is used once, and this one is spent",
  });
  return true;
}

/** Pass on whatever the orchestrator refused, so a bridge is never left guessing. */
function report(agentId: string, accepted: Accepted): void {
  if (!accepted.ok) send(agentId, { t: "error", detail: accepted.detail });
}

function handleFrame(socket: ServerWebSocket<SocketData>, raw: unknown): void {
  const frame = parseClientFrame(raw);
  if (frame === undefined) {
    const detail = describeFrameRejection(raw);
    console.warn(`rejected a frame: ${detail}`);
    socket.send(JSON.stringify({ t: "error", detail } satisfies ServerFrame));
    return;
  }

  // Everything except the handshake requires an established identity.
  if (frame.t === "hello") {
    const challenge = socket.data.challenge;
    if (challenge === undefined || frame.challenge !== challenge) {
      socket.send(
        JSON.stringify({ t: "error", detail: "answer the challenge for this socket" } satisfies ServerFrame),
      );
      socket.close();
      return;
    }
    if (!verifyChallenge(frame.did, challenge, frame.signature)) {
      socket.send(
        JSON.stringify({ t: "error", detail: "that signature does not match that did" } satisfies ServerFrame),
      );
      socket.close();
      return;
    }
    const row = store.agentByDid(frame.did);
    if (row === undefined) {
      socket.send(
        JSON.stringify({ t: "error", detail: "no agent has claimed that key" } satisfies ServerFrame),
      );
      socket.close();
      return;
    }
    // Spent. Without this a socket could be re-introduced as somebody else after the fact.
    delete socket.data.challenge;
    noLongerAnonymous(socket);
    // Register the new socket first so the outgoing close is stale and does not
    // look like the agent going offline.
    const previous = sockets.get(row.id);
    socket.data.agentId = row.id;
    sockets.set(row.id, socket);
    if (previous !== undefined && previous !== socket) previous.close();
    sendWelcome(row.id);
    send(row.id, { t: "directory", people: directoryFor(row.id) });
    orchestrator.replayTurns(row.id);
    orchestrator.onArrived(row.id);
    broadcastPresence();
    presence.announceAll(row.id);
    return;
  }

  // Answered before identity is checked: a keepalive is transport, not conversation, and a
  // socket still inside its hello grace has as much reason to stay warm as any other.
  if (frame.t === "ping") {
    socket.send(JSON.stringify({ t: "pong" } satisfies ServerFrame));
    return;
  }

  const agentId = socket.data.agentId;
  if (agentId === undefined) {
    socket.send(JSON.stringify({ t: "error", detail: "say hello first" } satisfies ServerFrame));
    return;
  }

  switch (frame.t) {
    case "profile.set": {
      store.updateProfile(agentId, frame.displayName, frame.bio);
      sendWelcome(agentId);
      return;
    }

    case "directory.list": {
      send(agentId, { t: "directory", people: directoryFor(agentId) });
      return;
    }

    case "invite.send": {
      const target = store.agentByTag(frame.toTag);
      if (target === undefined || target.id === agentId) {
        send(agentId, { t: "error", detail: "no agent here goes by that name and key" });
        return;
      }

      const existingConnection = store.connectionBetween(agentId, target.id);
      if (existingConnection !== undefined) {
        // Already connected: the invite's purpose line is already the first thing somebody
        // wanted to talk about, so open a new conversation on that connection rather than
        // making a person introduce themselves twice. Whoever asked for it is who opened it.
        const conversation = store.createConversation(
          existingConnection.id,
          frame.purpose,
          frame.limit,
          agentId,
        );
        if (conversation === undefined) return;
        for (const participant of [agentId, target.id]) {
          send(participant, { t: "conversation", conversation });
        }
        // Proposed, not started. Being connected is not consent to every later
        // conversation: this one has not been agreed to by the person whose agent it would
        // wake, and whose tokens it would spend.
        return;
      }

      const invite = store.createInvite(agentId, target.id, frame.purpose, frame.limit);
      if (invite === undefined) return;
      send(agentId, { t: "invite", invite });
      send(target.id, { t: "invite", invite });
      return;
    }

    case "invite.respond": {
      const invite = store.inviteById(frame.inviteId);
      if (invite === undefined || invite.to_agent !== agentId || invite.status !== "pending") {
        send(agentId, { t: "error", detail: "that invite is not yours to answer" });
        return;
      }
      store.setInviteStatus(invite.id, frame.accept ? "accepted" : "declined");

      const from = store.agentById(invite.from_agent);
      const to = store.agentById(invite.to_agent);
      if (from === undefined || to === undefined) return;

      const settled = store.inviteView(invite.id);
      if (settled === undefined) return;
      send(from.id, { t: "invite", invite: settled });
      send(to.id, { t: "invite", invite: settled });
      if (!frame.accept) return;

      // Accepting establishes the relationship *and* opens the first conversation, because
      // the invite's purpose line is already the first thing somebody wanted to talk about.
      const connectionId = store.createConnection(invite.from_agent, invite.to_agent);
      // The inviter opened it: it was their purpose line and theirs is the first turn.
      const proposal = store.createConversation(
        connectionId,
        invite.purpose,
        settled.limit,
        invite.from_agent,
      );
      if (proposal === undefined) return;
      // Live straight away, unlike a room opened on an existing connection: accepting the
      // invitation *is* the agreement to this conversation, and asking twice for the same
      // consent would be noise rather than care.
      store.setState(proposal.id, "live");
      const conversation = store.conversation(proposal.id);
      if (conversation === undefined) return;

      for (const participant of [from.id, to.id]) {
        const view = store.toConnection(
          connectionId,
          participant === from.id ? to.id : from.id,
          new Date().toISOString(),
          isOnline,
        );
        if (view !== undefined) send(participant, { t: "connected", connection: view, conversation });
      }

      // The purpose is a topic for the inviter's agent, not a line in its mouth — and not an
      // instruction in the hub's, either: it reaches the agent as `purpose` and the room
      // simply starts.
      orchestrator.onBegin(conversation.id, invite.from_agent);
      return;
    }

    case "conversation.open": {
      const participants = store.connectionParticipants(frame.connectionId);
      if (participants === undefined || !participants.includes(agentId)) {
        send(agentId, { t: "error", detail: "you are not part of that connection" });
        return;
      }
      const conversation = store.createConversation(
        frame.connectionId,
        frame.purpose,
        frame.limit,
        agentId,
      );
      if (conversation === undefined) return;
      for (const participant of participants) {
        send(participant, { t: "conversation", conversation });
      }
      // Deliberately no dispatch here. The room is proposed, and the first turn spends the
      // other owner's tokens and speaks in their name — so it waits for them to take it up.
      return;
    }

    case "conversation.respond": {
      const answered = store.respondToConversation(frame.conversationId, agentId, frame.accept);
      if (answered === undefined) {
        send(agentId, { t: "error", detail: "that conversation is not yours to answer" });
        return;
      }
      for (const participant of store.conversationParticipantIds(frame.conversationId) ?? []) {
        send(participant, { t: "conversation", conversation: answered });
      }
      // Accepting is what starts it, exactly as accepting an invitation does. The purpose
      // travels on its own field; the proposer's agent is the one asked to open.
      if (frame.accept) {
        const proposerId = store.proposerId(answered.id);
        if (proposerId !== undefined) {
          orchestrator.onBegin(answered.id, proposerId);
        }
      }
      return;
    }

    case "say": {
      if (roomFor(agentId, frame.conversationId) === undefined) return;
      if (!holdsTheFloor(agentId, frame.conversationId, frame.dispatch)) return;
      const author = store.agentById(agentId);
      const said = signedOrRefused(author, frame.authorship, agentId, (row, authorship) =>
        signatureFor(row, authorship, {
          conversationId: frame.conversationId,
          kind: "agent",
          dispatch: frame.dispatch,
          text: frame.text,
        }),
      );
      if (said === undefined) return;
      if (usedBefore(agentId, frame.conversationId, said)) return;
      report(
        agentId,
        orchestrator.said(frame.conversationId, agentId, {
          kind: "agent",
          text: frame.text,
          signature: said,
          dispatch: frame.dispatch,
          ...(frame.costUSD !== undefined ? { costUSD: frame.costUSD } : {}),
          costIncomplete: frame.costIncomplete === true,
          closing: frame.closing === true,
        }),
      );
      return;
    }

    case "limit.set": {
      if (roomFor(agentId, frame.conversationId) === undefined) return;
      // Either participant may set it. The rule caps what their own agent is asked to do as
      // much as the other's, so there is no side here to protect from the other.
      orchestrator.setLimit(frame.conversationId, frame.limit);
      return;
    }

    case "conversation.stop": {
      const participants = roomFor(agentId, frame.conversationId);
      if (participants === undefined) return;
      orchestrator.stop(frame.conversationId);
      const stopped = store.appendMessage({
        conversationId: frame.conversationId,
        authorAgentId: agentId,
        kind: "system",
        text: "stopped",
      });
      if (stopped !== undefined) {
        for (const participant of participants) send(participant, { t: "appended", message: stopped });
      }
      return;
    }

    case "conversation.add": {
      const participants = roomFor(agentId, frame.conversationId);
      if (participants === undefined) return;
      if (participants.length >= MAX_ROOM_MEMBERS) {
        send(agentId, {
          t: "error",
          detail: `a room holds at most ${String(MAX_ROOM_MEMBERS)} agents — every message wakes all of them`,
        });
        return;
      }
      const joining = store.agentByTag(frame.tag);
      if (joining === undefined) {
        send(agentId, { t: "error", detail: "no agent here goes by that name and key" });
        return;
      }
      if (participants.includes(joining.id)) {
        send(agentId, { t: "error", detail: `${frame.tag} is already here` });
        return;
      }
      // A connection is where somebody agreed to talk to you at all, and this spends that
      // rather than asking for something new. Without the check, knowing a handle would be
      // enough to pull a stranger into a room.
      if (store.connectionBetween(agentId, joining.id) === undefined) {
        send(agentId, {
          t: "error",
          detail: `you are not connected to ${frame.tag} — invite them first`,
        });
        return;
      }

      store.addMember(frame.conversationId, joining.id);
      const inviter = store.agentById(agentId);
      const note = store.appendMessage({
        conversationId: frame.conversationId,
        authorAgentId: agentId,
        kind: "system",
        text: `@${joining.handle} was brought in by @${inviter?.handle ?? "someone"}`,
      });
      // Everyone gets the new membership, and the newcomer gets the room and its history
      // the same way they would after a reconnect.
      const grown = store.conversation(frame.conversationId);
      for (const participant of store.conversationParticipantIds(frame.conversationId) ?? []) {
        if (grown !== undefined) send(participant, { t: "conversation", conversation: grown });
        if (note !== undefined) send(participant, { t: "appended", message: note });
      }
      sendWelcome(joining.id);
      presence.announce(frame.conversationId);
      // They have heard nothing yet, so the room owes them a turn if anything has been said.
      orchestrator.onJoined(frame.conversationId, joining.id);
      return;
    }

    case "conversation.leave": {
      if (roomFor(agentId, frame.conversationId) === undefined) return;
      const leaving = store.agentById(agentId);
      store.removeMember(frame.conversationId, agentId);
      const note = store.appendMessage({
        conversationId: frame.conversationId,
        authorAgentId: agentId,
        kind: "system",
        text: `@${leaving?.handle ?? "someone"} left`,
      });
      orchestrator.onLeft(frame.conversationId, agentId);

      const shrunk = store.conversation(frame.conversationId);
      // The leaver is told too: their app has to stop showing a room they are not in, and
      // this is the last frame about it they will get.
      for (const participant of [...(store.conversationParticipantIds(frame.conversationId) ?? []), agentId]) {
        if (shrunk !== undefined) send(participant, { t: "conversation", conversation: shrunk });
        if (note !== undefined) send(participant, { t: "appended", message: note });
      }
      presence.announce(frame.conversationId);
      return;
    }

    case "conversation.delete": {
      const participants = roomFor(agentId, frame.conversationId);
      if (participants === undefined) return;

      if (frame.scope === "everyone") {
        // A request, not an act: erasure needs every current member, and is said out loud in
        // the room while it waits. `scope: "me"` is the one that needs nobody. §3.
        const asked = store.askErase(frame.conversationId, agentId);
        if (store.everyoneAskedErase(frame.conversationId)) {
          orchestrator.discard(frame.conversationId, participants);
          store.deleteConversation(frame.conversationId);
          for (const participant of participants) {
            send(participant, { t: "conversation.removed", conversationId: frame.conversationId });
          }
          return;
        }
        // Repeating the ask is not a stronger ask, and must not say the same thing twice.
        if (!asked) return;
        const asker = store.agentById(agentId);
        const marked = store.conversation(frame.conversationId);
        const waiting = participants.length - (marked?.eraseAsked.length ?? 0);
        const note = store.appendMessage({
          conversationId: frame.conversationId,
          authorAgentId: agentId,
          kind: "system",
          text:
            `@${asker?.handle ?? "someone"} asked to erase this room for everyone — it goes ` +
            `once everybody has asked (${String(waiting)} still to agree)`,
        });
        // Re-read, because appending the note moved the room's `lastAt`.
        const announced = store.conversation(frame.conversationId);
        for (const participant of participants) {
          if (announced !== undefined) send(participant, { t: "conversation", conversation: announced });
          if (note !== undefined) send(participant, { t: "appended", message: note });
        }
        return;
      }

      // Quietly drop your own membership — no system message, no notice to anyone still
      // in the room, unlike `conversation.leave`. A hidden conversation, not a departure.
      store.removeMember(frame.conversationId, agentId);
      orchestrator.onLeft(frame.conversationId, agentId);
      send(agentId, { t: "conversation.removed", conversationId: frame.conversationId });

      const shrunk = store.conversation(frame.conversationId);
      if (shrunk !== undefined) {
        for (const participant of store.conversationParticipantIds(frame.conversationId) ?? []) {
          send(participant, { t: "conversation", conversation: shrunk });
        }
      }
      presence.announce(frame.conversationId);
      return;
    }

    case "conversation.reopen": {
      const participants = roomFor(agentId, frame.conversationId);
      if (participants === undefined) return;
      orchestrator.reopen(frame.conversationId);
      const reopened = store.appendMessage({
        conversationId: frame.conversationId,
        authorAgentId: agentId,
        kind: "system",
        text: "reopened",
      });
      if (reopened !== undefined) {
        for (const participant of participants) {
          send(participant, { t: "appended", message: reopened });
        }
      }
      return;
    }

    case "history.load": {
      if (roomFor(agentId, frame.conversationId) === undefined) return;
      // Answered only to the asker: this is somebody scrolling, not an event in the room.
      const page = store.historyBefore(frame.conversationId, frame.beforeId, HISTORY_PAGE_SIZE);
      send(agentId, {
        t: "history",
        conversationId: frame.conversationId,
        messages: page.messages,
        reachedStart: page.reachedStart,
      });
      return;
    }

    case "nudge": {
      if (roomFor(agentId, frame.conversationId) === undefined) return;
      orchestrator.onNudge(frame.conversationId, agentId, frame.steer);
      return;
    }

    case "pass": {
      if (roomFor(agentId, frame.conversationId) === undefined) return;
      if (!holdsTheFloor(agentId, frame.conversationId, frame.dispatch)) return;
      const passer = store.agentById(agentId);
      const silence = signedOrRefused(passer, frame.authorship, agentId, (row, authorship) =>
        signatureFor(row, authorship, {
          conversationId: frame.conversationId,
          kind: "pass",
          dispatch: frame.dispatch,
          text: "",
        }),
      );
      if (silence === undefined) return;
      if (usedBefore(agentId, frame.conversationId, silence)) return;
      // A pass ran a model, so it cost something and is charged like any other turn.
      report(
        agentId,
        orchestrator.said(frame.conversationId, agentId, {
          kind: "pass",
          text: "",
          signature: silence,
          dispatch: frame.dispatch,
          ...(frame.costUSD !== undefined ? { costUSD: frame.costUSD } : {}),
          costIncomplete: frame.costIncomplete === true,
          closing: false,
        }),
      );
      return;
    }

    case "watch": {
      if (frame.conversationId !== undefined && roomFor(agentId, frame.conversationId) === undefined) {
        return;
      }
      presence.watch(agentId, frame.conversationId);
      return;
    }

    case "progress": {
      if (roomFor(agentId, frame.conversationId) === undefined) return;
      // Held to the same rule as a message: "my agent is reading your calendar" is a line in
      // somebody else's room, and an agent with no turn has no business putting one there.
      if (!holdsTheFloor(agentId, frame.conversationId, frame.dispatch)) return;
      orchestrator.onProgress(frame.conversationId, agentId);
      presence.note(frame.conversationId, agentId, frame.note);
      return;
    }

    case "waiting": {
      if (roomFor(agentId, frame.conversationId) === undefined) return;
      if (!holdsTheFloor(agentId, frame.conversationId, frame.dispatch)) return;
      orchestrator.onWaiting(frame.conversationId, agentId);
      return;
    }

    case "trouble": {
      if (roomFor(agentId, frame.conversationId) === undefined) return;
      if (!holdsTheFloor(agentId, frame.conversationId, frame.dispatch)) return;
      report(agentId, orchestrator.troubled(frame.conversationId, agentId, frame.dispatch, frame.reason));
      return;
    }

    default:
      return;
  }
}

const server = Bun.serve<SocketData, never>({
  port: PORT,
  hostname: HOST,
  ...(SERVES_TLS ? { tls: { cert: Bun.file(TLS_CERT), key: Bun.file(TLS_KEY) } } : {}),
  fetch(request, bunServer) {
    // The socket's own peer address, not a forwarded header: a header is whatever the
    // caller wrote unless there is a proxy in front that is trusted to overwrite it, and a
    // hub anybody can run has no way to know whether there is.
    const address = bunServer.requestIP(request)?.address ?? "unknown";
    if (new URL(request.url).pathname === "/socket") {
      // Both ceilings are checked before the upgrade, so a flood costs a refused handshake
      // rather than a socket the hub then has to reason about.
      if (openSockets.size >= MAX_SOCKETS) {
        return new Response("this hub is full", { status: 503, headers: { "retry-after": "30" } });
      }
      if ((anonymous.get(address) ?? 0) >= MAX_ANONYMOUS_PER_ADDRESS) {
        return new Response("too many unauthenticated sockets from here", {
          status: 429,
          headers: { "retry-after": "10" },
        });
      }
      const id = newNonce();
      return bunServer.upgrade(request, { data: { id, address } })
        ? undefined
        : new Response("expected a websocket upgrade", { status: 426 });
    }
    return app.fetch(request, { ip: address });
  },
  websocket: {
    // Bun closes anything larger itself rather than buffering it, which is the point: the
    // limit has to bind before the frame is in memory to be worth having.
    maxPayloadLength: MAX_FRAME_BYTES,
    // Stated rather than inherited. A bridge pings every SOCKET_KEEPALIVE_MS, so anything
    // quiet for this long is not idle, it is gone — and holding it open holds presence open
    // with it, telling a room somebody is there who is not.
    idleTimeout: SOCKET_IDLE_TIMEOUT_S,
    sendPings: true,
    open(socket) {
      openSockets.add(socket);
      countAnonymous(socket.data.address, 1);
      // A socket that never says who it is holds a slot, a challenge and a buffer for
      // nothing. It has one frame to send, and ten seconds to send it.
      socket.data.helloBy = setTimeout(() => {
        socket.close(1008, "say hello first");
      }, HELLO_GRACE_MS);
      // Per socket, not per agent: a challenge reused across connections is a recording
      // somebody can replay, which is most of what a bearer token already was.
      const nonce = newNonce();
      socket.data.challenge = nonce;
      socket.send(JSON.stringify({ t: "challenge", nonce } satisfies ServerFrame));
    },
    message(socket, raw) {
      // Charged before the frame is parsed, so a flood of malformed frames costs a sender
      // exactly what a flood of valid ones does.
      if (!frameRate.take(socket.data.id).allowed) {
        socket.send(
          JSON.stringify({ t: "error", detail: "too many frames — slow down" } satisfies ServerFrame),
        );
        socket.close(1008, "too many frames");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        socket.send(JSON.stringify({ t: "error", detail: "expected JSON" } satisfies ServerFrame));
        return;
      }
      handleFrame(socket, parsed);
    },
    close(socket, code, reason) {
      openSockets.delete(socket);
      noLongerAnonymous(socket);
      const agentId = socket.data.agentId;
      // Said out loud, because a hub that logged nothing here looked identical whether it was
      // dropping every socket it had or none, and a bridge reporting repeated disconnects had
      // no counterpart to check its story against.
      const who = agentId === undefined ? "an unauthenticated socket" : describeAgent(agentId);
      console.warn(
        `socket closed: ${who} — code ${String(code)}${reason ? ` (${reason})` : ""}`,
      );
      if (agentId === undefined) return;
      // A replaced socket must not look like the agent leaving.
      if (sockets.get(agentId) !== socket) return;
      sockets.delete(agentId);
      orchestrator.onDisconnect(agentId);
      presence.clear(agentId);
      broadcastPresence();
    },
  },
});

// Before anything can connect, and after presence is wired: a recovered deadline that has
// already expired fires on the next tick and appends to the room it belonged to.
orchestrator.recover();

const scheme = SERVES_TLS ? "https" : "http";
console.log(`quartet hub listening on ${scheme}://${HOST}:${String(server.port)}`);

// A friend's bridge dials out to this hub, same as yours does — it never needs to reach your
// machine directly. What it needs is a URL that reaches *this* one, which `--tunnel` gets via
// a cloudflared quick tunnel rather than asking anyone to deploy or forward a port just to
// invite one person. The `cloudflared` binary itself is fetched on first use if it is not
// already on this machine, so `--tunnel` needs nothing installed ahead of time.
if (process.argv.includes("--tunnel")) {
  console.log("\n  starting a cloudflare quick tunnel…");
  const tunnel = await startTunnel(PORT);
  switch (tunnel.kind) {
    case "ok": {
      console.log(`\n  ✓ reachable at ${tunnel.url}`);
      console.log(`    give this to whoever you're inviting: ${tunnel.url}/join`);
      console.log("    it's a page with the one command to run, not a bare URL.\n");
      const stopTunnel = (): void => {
        tunnel.stop();
        process.exit(0);
      };
      process.on("SIGINT", stopTunnel);
      process.on("SIGTERM", stopTunnel);
      break;
    }
    case "download-failed":
      console.warn(`\n  ! could not fetch cloudflared: ${tunnel.detail}`);
      console.warn(
        "    Install it yourself: https://developers.cloudflare.com/cloudflare-one/" +
          "connections/connect-networks/downloads/\n",
      );
      break;
    case "timed-out":
      console.warn("\n  ! cloudflared did not report a public URL within 30s. Try again, or run");
      console.warn(`    \`cloudflared tunnel --url http://localhost:${String(PORT)}\` yourself to see why.\n`);
      break;
    case "failed":
      console.warn(`\n  ! could not start a tunnel: ${tunnel.detail}\n`);
      break;
  }
}
