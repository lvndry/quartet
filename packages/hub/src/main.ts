/**
 * @fileoverview The hub: a socket router with a database, and nothing else.
 *
 * It holds no model keys and makes no model calls — every token spent in quartet is spent on
 * a participant's own machine with their own key. That is what makes a public instance
 * survivable: hosting cost is flat, and there is no free-inference abuse vector to defend.
 *
 * It also holds no ledgers. What an agent said is recorded by its own bridge, locally. The
 * hub stores conversations because both parties need them, and stops there.
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
import { Orchestrator } from "./orchestrator";
import { RoomPresence } from "./presence";
import { RateLimiter } from "./rate-limit";

const PORT = Number(process.env["PORT"] ?? 8080);
const DB_PATH = process.env["QUARTET_DB"] ?? "quartet.sqlite";

const store = new HubStore(DB_PATH);

/** Live bridges, by agent. Presence in quartet is exactly "your bridge is connected". */
const sockets = new Map<string, ServerWebSocket<SocketData>>();

interface SocketData {
  agentId?: string;
  /** Issued when the socket opens; the only string a hello on this socket may answer. */
  challenge?: string;
}

function isOnline(agentId: string): boolean {
  return sockets.has(agentId);
}

function send(agentId: string, frame: ServerFrame): void {
  sockets.get(agentId)?.send(JSON.stringify(frame));
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
 * Tell everyone who can see this agent that its presence changed.
 *
 * That is currently everyone, because the directory lists every agent — which is the whole
 * point at this size, where the problem is finding anyone at all rather than filtering. It
 * is O(online²) per connect and will need scoping to connections plus a search endpoint long
 * before the directory becomes worth scrolling.
 */
function broadcastPresence(): void {
  for (const [agentId] of sockets) {
    send(agentId, { t: "directory", people: directoryFor(agentId) });
  }
}

/**
 * How many identities one address may claim: a roomful at once, then one every twenty minutes.
 *
 * The burst is `MAX_ROOM_MEMBERS` because that is the largest number of agents somebody has
 * a legitimate reason to stand up in one go — a full room on one machine, for a demo or a
 * test. It was three, which is a number with nothing behind it, and it turned out to block
 * exactly that case. What actually stops a namespace being taken is the refill rate, not
 * the burst.
 *
 * A stopgap either way: a claim proves nothing about who is making it, and only agent
 * identity fixes that. This stops the cheapest version of the attack.
 *
 * `QUARTET_REGISTRATION_BURST` raises it for `bun run smoke`, which mints a cast of agents
 * against a throwaway hub and also makes a run of deliberately refused claims — every one of
 * which costs a token — before exercising this ceiling on purpose. A roomful does not cover
 * that, and the harness should not have to fit inside a rule aimed at the public internet.
 */
const registrations = new RateLimiter({
  burst: Number(process.env["QUARTET_REGISTRATION_BURST"] ?? MAX_ROOM_MEMBERS),
  refillMs: 20 * 60_000,
});

/** `ip` is filled in from the socket by the server below, because Hono cannot see it. */
const app = new Hono<{ Bindings: { ip: string } }>();

app.get("/health", (context) => context.json({ ok: true }));

/**
 * How far out of step with the hub a claiming machine's clock may be.
 *
 * The window exists so a claim overheard on the wire cannot be replayed at leisure against a
 * hub that has since forgotten the handle. Ten minutes rather than seconds because the cost
 * of being strict falls entirely on the honest user with a drifting laptop clock, and a
 * replay window measured in minutes is not the weak point in any attack worth worrying about.
 */
const CLAIM_WINDOW_MS = 10 * 60 * 1000;

function withinClaimWindow(at: string): boolean {
  const claimed = Date.parse(at);
  return Number.isFinite(claimed) && Math.abs(Date.now() - claimed) < CLAIM_WINDOW_MS;
}

/**
 * Claim a handle.
 *
 * A claim carries a `did:key` and a signature over the handle, so a name is handed only to
 * somebody who demonstrably holds the key that will be signing under it. The hub still cannot
 * say a key belongs to a particular *person* — fingerprints compared out of band are what
 * settle that — but from here one key means one handle, and nobody, the hub included, can
 * quietly put a different key behind a name that somebody already knows.
 *
 * Nothing secret comes back. The key is the credential, and it never left the machine that
 * made it, so there is no token here to leak, to lose, or to have to rotate.
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
 * The hub cannot forge one of these and does not need to trust one — the far side checks it
 * again on arrival, which is the check that counts. This pass exists so that a broken
 * signature is refused at the door with something a person can read, rather than travelling
 * to somebody else's screen to be reported there as a correspondent who cannot be trusted.
 * A hub is the wrong place to *establish* authorship and the right place to notice skew.
 *
 * Undefined means refuse.
 */
function signatureFor(
  author: AgentRow,
  authorship: Authorship,
  covered: { conversationId: string; kind: MessageKind; text: string },
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
      text: covered.text,
    },
    authorship.signature,
  );
  return ok ? signature : undefined;
}

/**
 * Check what an agent signed, or refuse the frame and say why.
 *
 * There is no third answer. Opening a socket means proving a key, so every connected bridge
 * can sign — a line that arrives without a good signature is version skew or somebody
 * trying something, and neither should be quietly relayed as merely unverifiable.
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
      const target = store.agentByHandle(frame.toHandle);
      if (target === undefined || target.id === agentId) {
        send(agentId, { t: "error", detail: "no agent with that handle" });
        return;
      }
      if (store.connectionBetween(agentId, target.id) !== undefined) {
        send(agentId, { t: "error", detail: "you are already connected" });
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
      const conversation = store.createConversation(
        connectionId,
        invite.purpose,
        settled.limit,
        invite.from_agent,
      );
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

      // The purpose is a topic for the inviter's agent, not a line in its mouth.
      orchestrator.onNudge(conversation.id, invite.from_agent, invite.purpose);
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
      orchestrator.onNudge(conversation.id, agentId, frame.purpose);
      return;
    }

    case "say": {
      const participants = store.conversationParticipantIds(frame.conversationId);
      if (participants === undefined || !participants.includes(agentId)) {
        send(agentId, { t: "error", detail: "you are not in that conversation" });
        return;
      }
      const author = store.agentById(agentId);
      const said = signedOrRefused(author, frame.authorship, agentId, (row, authorship) =>
        signatureFor(row, authorship, {
          conversationId: frame.conversationId,
          kind: "agent",
          text: frame.text,
        }),
      );
      if (said === undefined) return;
      const message = store.appendMessage({
        conversationId: frame.conversationId,
        authorAgentId: agentId,
        kind: "agent",
        text: frame.text,
        signature: said,
      });
      if (message === undefined) return;
      orchestrator.onSpend(frame.conversationId, frame.costUSD, frame.costIncomplete === true);
      if (frame.closing === true) {
        // Delivered and closed in one step: fanning out first would dispatch a reply, and
        // the goodbye would be answered.
        orchestrator.closeWith(frame.conversationId, agentId, message);
        return;
      }
      orchestrator.onTurnSettled(frame.conversationId, agentId, "spoke");
      orchestrator.onMessage(frame.conversationId, agentId, message);
      return;
    }

    case "limit.set": {
      const participants = store.conversationParticipantIds(frame.conversationId);
      if (participants === undefined || !participants.includes(agentId)) {
        send(agentId, { t: "error", detail: "you are not in that conversation" });
        return;
      }
      // Either participant may set it. The rule caps what their own agent is asked to do as
      // much as the other's, so there is no side here to protect from the other.
      orchestrator.setLimit(frame.conversationId, frame.limit);
      return;
    }

    case "conversation.stop": {
      const participants = store.conversationParticipantIds(frame.conversationId);
      if (participants === undefined || !participants.includes(agentId)) {
        send(agentId, { t: "error", detail: "you are not in that conversation" });
        return;
      }
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
      const participants = store.conversationParticipantIds(frame.conversationId);
      if (participants === undefined || !participants.includes(agentId)) {
        send(agentId, { t: "error", detail: "you are not in that conversation" });
        return;
      }
      if (participants.length >= MAX_ROOM_MEMBERS) {
        send(agentId, {
          t: "error",
          detail: `a room holds at most ${String(MAX_ROOM_MEMBERS)} agents — every message wakes all of them`,
        });
        return;
      }
      const joining = store.agentByHandle(frame.handle);
      if (joining === undefined) {
        send(agentId, { t: "error", detail: "no agent with that handle" });
        return;
      }
      if (participants.includes(joining.id)) {
        send(agentId, { t: "error", detail: `@${frame.handle} is already here` });
        return;
      }
      // A connection is where somebody agreed to talk to you at all, and this spends that
      // rather than asking for something new. Without the check, knowing a handle would be
      // enough to pull a stranger into a room.
      if (store.connectionBetween(agentId, joining.id) === undefined) {
        send(agentId, {
          t: "error",
          detail: `you are not connected to @${frame.handle} — invite them first`,
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
      const participants = store.conversationParticipantIds(frame.conversationId);
      if (participants === undefined || !participants.includes(agentId)) {
        send(agentId, { t: "error", detail: "you are not in that conversation" });
        return;
      }
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

    case "conversation.reopen": {
      const participants = store.conversationParticipantIds(frame.conversationId);
      if (participants === undefined || !participants.includes(agentId)) {
        send(agentId, { t: "error", detail: "you are not in that conversation" });
        return;
      }
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
      const participants = store.conversationParticipantIds(frame.conversationId);
      if (participants === undefined || !participants.includes(agentId)) {
        send(agentId, { t: "error", detail: "you are not in that conversation" });
        return;
      }
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
      const participants = store.conversationParticipantIds(frame.conversationId);
      if (participants === undefined || !participants.includes(agentId)) {
        send(agentId, { t: "error", detail: "you are not in that conversation" });
        return;
      }
      orchestrator.onNudge(frame.conversationId, agentId, frame.steer);
      return;
    }

    case "pass": {
      const participants = store.conversationParticipantIds(frame.conversationId);
      if (participants === undefined || !participants.includes(agentId)) {
        send(agentId, { t: "error", detail: "you are not in that conversation" });
        return;
      }
      const passer = store.agentById(agentId);
      const silence = signedOrRefused(passer, frame.authorship, agentId, (row, authorship) =>
        signatureFor(row, authorship, {
          conversationId: frame.conversationId,
          kind: "pass",
          text: "",
        }),
      );
      if (silence === undefined) return;
      const message = store.appendMessage({
        conversationId: frame.conversationId,
        authorAgentId: agentId,
        kind: "pass",
        text: "",
        signature: silence,
      });
      // A pass ran a model, so it cost something and is charged like any other turn.
      orchestrator.onSpend(frame.conversationId, frame.costUSD, frame.costIncomplete === true);
      orchestrator.onTurnSettled(frame.conversationId, agentId, "passed");
      if (message === undefined) return;
      // A pass is recorded and shown, but it deliberately does not wake the other agent:
      // silence is not something to reply to.
      for (const participant of participants) send(participant, { t: "appended", message });
      return;
    }

    case "watch": {
      if (frame.conversationId !== undefined) {
        const participants = store.conversationParticipantIds(frame.conversationId);
        if (participants === undefined || !participants.includes(agentId)) {
          send(agentId, { t: "error", detail: "you are not in that conversation" });
          return;
        }
      }
      presence.watch(agentId, frame.conversationId);
      return;
    }

    case "progress": {
      const participants = store.conversationParticipantIds(frame.conversationId);
      if (participants === undefined || !participants.includes(agentId)) {
        send(agentId, { t: "error", detail: "you are not in that conversation" });
        return;
      }
      orchestrator.onProgress(frame.conversationId, agentId);
      return;
    }

    case "waiting": {
      const participants = store.conversationParticipantIds(frame.conversationId);
      if (participants === undefined || !participants.includes(agentId)) {
        send(agentId, { t: "error", detail: "you are not in that conversation" });
        return;
      }
      orchestrator.onWaiting(frame.conversationId, agentId);
      return;
    }

    case "trouble": {
      const participants = store.conversationParticipantIds(frame.conversationId);
      if (participants === undefined || !participants.includes(agentId)) {
        send(agentId, { t: "error", detail: "you are not in that conversation" });
        return;
      }
      const message = store.appendMessage({
        conversationId: frame.conversationId,
        authorAgentId: agentId,
        kind: "system",
        text: frame.reason,
      });
      orchestrator.onTurnSettled(frame.conversationId, agentId, "failed");
      if (message === undefined) return;
      for (const participant of participants) send(participant, { t: "appended", message });
      return;
    }

    default:
      return;
  }
}

const server = Bun.serve<SocketData, never>({
  port: PORT,
  fetch(request, bunServer) {
    if (new URL(request.url).pathname === "/socket") {
      return bunServer.upgrade(request, { data: {} })
        ? undefined
        : new Response("expected a websocket upgrade", { status: 426 });
    }
    // The socket's own peer address, not a forwarded header: a header is whatever the
    // caller wrote unless there is a proxy in front that is trusted to overwrite it, and a
    // hub anybody can run has no way to know whether there is.
    return app.fetch(request, { ip: bunServer.requestIP(request)?.address ?? "unknown" });
  },
  websocket: {
    open(socket) {
      // Per socket, not per agent: a challenge reused across connections is a recording
      // somebody can replay, which is most of what a bearer token already was.
      const nonce = newNonce();
      socket.data.challenge = nonce;
      socket.send(JSON.stringify({ t: "challenge", nonce } satisfies ServerFrame));
    },
    message(socket, raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        socket.send(JSON.stringify({ t: "error", detail: "expected JSON" } satisfies ServerFrame));
        return;
      }
      handleFrame(socket, parsed);
    },
    close(socket) {
      const agentId = socket.data.agentId;
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

console.log(`quartet hub listening on http://localhost:${String(server.port)}`);
