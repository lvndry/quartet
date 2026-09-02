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
  parseClientFrame,
  type Agent,
  type DirectoryEntry,
  type ServerFrame,
} from "@quartet/protocol";
import { HubStore } from "./db";
import { Orchestrator } from "./orchestrator";

const PORT = Number(process.env["PORT"] ?? 8080);
const DB_PATH = process.env["QUARTET_DB"] ?? "quartet.sqlite";

const store = new HubStore(DB_PATH);

/** Live bridges, by agent. Presence in quartet is exactly "your bridge is connected". */
const sockets = new Map<string, ServerWebSocket<SocketData>>();

interface SocketData {
  agentId?: string;
}

function isOnline(agentId: string): boolean {
  return sockets.has(agentId);
}

function send(agentId: string, frame: ServerFrame): void {
  sockets.get(agentId)?.send(JSON.stringify(frame));
}

const orchestrator = new Orchestrator(store, send, isOnline);

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

const app = new Hono();

app.get("/health", (context) => context.json({ ok: true }));

/**
 * Claim a handle and get a token.
 *
 * No password and no email: the token *is* the identity, held by one bridge on one machine.
 * Nothing here proves a handle belongs to who it claims — impersonation is a real gap, and
 * a deliberate one at this scale, where invites are exchanged out of band between people
 * who already know each other.
 */
app.post("/agents", async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return context.json({ error: "expected a JSON body" }, 400);

  const handle = handleSchema.safeParse(body["handle"]);
  if (!handle.success) {
    return context.json({ error: handle.error.issues[0]?.message ?? "invalid handle" }, 400);
  }
  const displayName = typeof body["displayName"] === "string" ? body["displayName"].trim() : "";
  if (displayName.length === 0) return context.json({ error: "displayName is required" }, 400);

  const token = crypto.randomUUID().replaceAll("-", "");
  const created = store.createAgent({
    handle: handle.data,
    displayName,
    ...(typeof body["bio"] === "string" ? { bio: body["bio"] } : {}),
    token,
  });
  if (created === undefined) return context.json({ error: "that handle is taken" }, 409);

  return context.json({ token, agent: store.toAgent(created, false) }, 201);
});

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
    const row = store.agentByToken(frame.agentToken);
    if (row === undefined) {
      socket.send(JSON.stringify({ t: "error", detail: "unknown agent token" } satisfies ServerFrame));
      socket.close();
      return;
    }
    // Register the new socket first so the outgoing close is stale and does not
    // look like the agent going offline.
    const previous = sockets.get(row.id);
    socket.data.agentId = row.id;
    sockets.set(row.id, socket);
    if (previous !== undefined && previous !== socket) previous.close();
    sendWelcome(row.id);
    send(row.id, { t: "directory", people: directoryFor(row.id) });
    orchestrator.replayTurns(row.id);
    broadcastPresence();
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
      const invite = store.createInvite(agentId, target.id, frame.purpose);
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

      const settled = {
        id: invite.id,
        fromHandle: from.handle,
        toHandle: to.handle,
        purpose: invite.purpose,
        status: frame.accept ? ("accepted" as const) : ("declined" as const),
        at: invite.created_at,
      };
      send(from.id, { t: "invite", invite: settled });
      send(to.id, { t: "invite", invite: settled });
      if (!frame.accept) return;

      // Accepting establishes the relationship *and* opens the first conversation, because
      // the invite's purpose line is already the first thing somebody wanted to talk about.
      const connectionId = store.createConnection(invite.from_agent, invite.to_agent);
      const conversation = store.createConversation(connectionId, invite.purpose);
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
      const conversation = store.createConversation(frame.connectionId, frame.purpose, frame.limit);
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
      const message = store.appendMessage({
        conversationId: frame.conversationId,
        authorAgentId: agentId,
        kind: "agent",
        text: frame.text,
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
      const message = store.appendMessage({
        conversationId: frame.conversationId,
        authorAgentId: agentId,
        kind: "pass",
        text: "",
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
    return app.fetch(request);
  },
  websocket: {
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
      broadcastPresence();
    },
  },
});

console.log(`quartet hub listening on http://localhost:${String(server.port)}`);
