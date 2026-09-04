import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HISTORY_PAGE_SIZE,
  TURN_OVERLAP,
  TURN_SLICE_MAX,
  WELCOME_TRANSCRIPT_WINDOW,
} from "@quartet/protocol";
import { HubStore } from "./db";

function setup(messageCount: number) {
  const store = new HubStore(":memory:");
  const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
  const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
  if (mira === undefined || otto === undefined) throw new Error("agents");
  const connectionId = store.createConnection(mira.id, otto.id);
  const conversation = store.createConversation(connectionId, "find a time");
  if (conversation === undefined) throw new Error("conversation");

  for (let index = 0; index < messageCount; index += 1) {
    store.appendMessage({
      conversationId: conversation.id,
      authorAgentId: index % 2 === 0 ? mira.id : otto.id,
      kind: "agent",
      text: `line ${String(index)}`,
    });
  }
  return { store, mira, otto, conversation };
}

describe("hydrating a room", () => {
  it("carries a window rather than the whole history", () => {
    const { store, mira } = setup(WELCOME_TRANSCRIPT_WINDOW * 3);
    const carried = store.messagesForAgent(mira.id);

    expect(carried).toHaveLength(WELCOME_TRANSCRIPT_WINDOW);
    // The newest end of the room, oldest first — what somebody opening the app wants to see.
    expect(carried[carried.length - 1]?.text).toBe(`line ${String(WELCOME_TRANSCRIPT_WINDOW * 3 - 1)}`);
  });

  it("resolves each author once, not once per message", () => {
    const { store, mira } = setup(5);
    const carried = store.messagesForAgent(mira.id);

    expect(carried.map((message) => message.authorHandle)).toEqual([
      "mira",
      "otto",
      "mira",
      "otto",
      "mira",
    ]);
  });
});

describe("paging back through a room", () => {
  it("hands back the page before a message, oldest first", () => {
    const { store, conversation } = setup(30);
    const recent = store.transcript(conversation.id, 10);
    const oldestHeld = recent[0];
    if (oldestHeld === undefined) throw new Error("transcript");

    const page = store.historyBefore(conversation.id, oldestHeld.id, 5);

    expect(page.messages.map((message) => message.text)).toEqual([
      "line 15",
      "line 16",
      "line 17",
      "line 18",
      "line 19",
    ]);
    expect(page.reachedStart).toBe(false);
  });

  it("says when there is nothing older", () => {
    const { store, conversation } = setup(8);
    const all = store.transcript(conversation.id, 8);
    const third = all[2];
    if (third === undefined) throw new Error("transcript");

    const page = store.historyBefore(conversation.id, third.id, HISTORY_PAGE_SIZE);

    expect(page.messages.map((message) => message.text)).toEqual(["line 0", "line 1"]);
    expect(page.reachedStart).toBe(true);
  });

  it("reconstructs the room exactly, with no gap and no message twice", () => {
    // Messages appended in one tick share a timestamp, so this leans on the whole keyset
    // cursor rather than only on `at`. An offset would have drifted here.
    const total = WELCOME_TRANSCRIPT_WINDOW + HISTORY_PAGE_SIZE + 17;
    const { store, conversation } = setup(total);

    let collected = store.transcript(conversation.id, WELCOME_TRANSCRIPT_WINDOW);
    let reachedStart = collected.length < WELCOME_TRANSCRIPT_WINDOW;
    while (!reachedStart) {
      const oldest = collected[0];
      if (oldest === undefined) break;
      const page = store.historyBefore(conversation.id, oldest.id, HISTORY_PAGE_SIZE);
      collected = [...page.messages, ...collected];
      reachedStart = page.reachedStart;
    }

    expect(collected).toHaveLength(total);
    expect(new Set(collected.map((message) => message.id)).size).toBe(total);
    expect(collected.map((message) => message.text)).toEqual(
      Array.from({ length: total }, (_unused, index) => `line ${String(index)}`),
    );
  });

  it("treats an anchor it has never heard of as the start", () => {
    const { store, conversation } = setup(4);
    const page = store.historyBefore(conversation.id, "msg_nonexistent", HISTORY_PAGE_SIZE);

    expect(page.messages).toHaveLength(0);
    expect(page.reachedStart).toBe(true);
  });
});

describe("turns the hub is waiting on", () => {
  it("round-trips one, and forgets it when cleared", () => {
    const { store, mira, conversation } = setup(0);
    store.saveInFlight(conversation.id, mira.id, {
      pending: true,
      steered: true,
      queuedSteer: "and mention the deposit",
      dispatchSteer: "settle the date",
    });

    const held = store.allInFlight();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      conversationId: conversation.id,
      agentId: mira.id,
      entry: {
        pending: true,
        steered: true,
        queuedSteer: "and mention the deposit",
        dispatchSteer: "settle the date",
      },
    });
    expect(typeof held[0]?.dispatchedAt).toBe("string");

    store.clearInFlight(conversation.id, mira.id);
    expect(store.allInFlight()).toHaveLength(0);
  });

  it("keeps the original dispatch time when a follow-up is queued behind it", async () => {
    const { store, mira, conversation } = setup(0);
    store.saveInFlight(conversation.id, mira.id, { pending: false, steered: false });
    const first = store.allInFlight()[0]?.dispatchedAt;

    await Bun.sleep(5);
    store.saveInFlight(conversation.id, mira.id, { pending: true, steered: false });

    // The deadline a recovered turn gets is measured from when the money was spent, so an
    // update must not quietly restart that clock.
    expect(store.allInFlight()[0]?.dispatchedAt).toBe(first);
    expect(store.allInFlight()[0]?.entry.pending).toBe(true);
  });

  it("leaves no queued steer behind when there was none", () => {
    const { store, mira, conversation } = setup(0);
    store.saveInFlight(conversation.id, mira.id, { pending: false, steered: false });

    expect(store.allInFlight()[0]?.entry).toEqual({ pending: false, steered: false });
  });
});

describe("opening a database written by an older build", () => {
  it("reads a stopped room as halted, which is the reading a person can undo", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "quartet-migrate-"));
    const path = join(workDir, "old.sqlite");

    // The shape a hub wrote before rooms had three states: one boolean that cannot say
    // whether a person pressed stop or an agent said goodbye.
    const old = new Database(path, { create: true });
    old.exec(`
      CREATE TABLE owners (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, handle TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL, bio TEXT, token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE connections (
        id TEXT PRIMARY KEY, a_agent TEXT NOT NULL, b_agent TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE (a_agent, b_agent)
      );
      CREATE TABLE invites (
        id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
        purpose TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, purpose TEXT NOT NULL,
        budget INTEGER NOT NULL, stopped INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, last_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, author_agent TEXT NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL
      );
      INSERT INTO owners VALUES ('own_1', '2026-01-01T00:00:00.000Z');
      INSERT INTO agents VALUES ('agt_1', 'own_1', 'mira', 'Mira', NULL, 'tok', '2026-01-01T00:00:00.000Z');
      INSERT INTO connections VALUES ('con_1', 'agt_1', 'agt_1', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversations VALUES ('cnv_stopped', 'con_1', 'p', 5, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversations VALUES ('cnv_running', 'con_1', 'p', 5, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    old.close();

    const store = new HubStore(path);
    const halted = store.conversation("cnv_stopped");
    const live = store.conversation("cnv_running");

    expect(halted?.state).toBe("halted");
    expect(live?.state).toBe("live");

    await rm(workDir, { recursive: true, force: true });
  });
});

describe("whether a room owes an agent a turn", () => {
  function room() {
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
    if (mira === undefined || otto === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const conversation = store.createConversation(connectionId, "what is free will");
    if (conversation === undefined) throw new Error("conversation");
    const say = (agentId: string, kind: "agent" | "pass" | "system", text = "") => {
      store.appendMessage({ conversationId: conversation.id, authorAgentId: agentId, kind, text });
    };
    return { store, mira, otto, conversation, say };
  }

  it("owes nobody anything in an empty room", () => {
    const { store, mira, otto, conversation } = room();

    expect(store.owesTurn(conversation.id, mira.id)).toBe(false);
    expect(store.owesTurn(conversation.id, otto.id)).toBe(false);
  });

  it("owes the agent that was spoken to, and not the speaker", () => {
    const { store, mira, otto, conversation, say } = room();
    say(mira.id, "agent", "free will is compatible with determinism");

    expect(store.owesTurn(conversation.id, otto.id)).toBe(true);
    expect(store.owesTurn(conversation.id, mira.id)).toBe(false);
  });

  it("stops owing once the agent has spoken", () => {
    const { store, mira, otto, conversation, say } = room();
    say(mira.id, "agent", "a claim");
    say(otto.id, "agent", "a rebuttal");

    expect(store.owesTurn(conversation.id, otto.id)).toBe(false);
    expect(store.owesTurn(conversation.id, mira.id)).toBe(true);
  });

  it("treats a pass as an answer, because it was a deliberate one", () => {
    const { store, mira, otto, conversation, say } = room();
    say(mira.id, "agent", "a claim");
    say(otto.id, "pass");

    // Otto ran a model and chose to say nothing. Asking again on reconnect would spend
    // another turn re-deciding the same silence.
    expect(store.owesTurn(conversation.id, otto.id)).toBe(false);
  });

  it("does not treat the other side's pass as something to answer", () => {
    const { store, mira, otto, conversation, say } = room();
    say(mira.id, "pass");

    expect(store.owesTurn(conversation.id, otto.id)).toBe(false);
  });

  it("does not treat the room talking about itself as something to answer", () => {
    const { store, mira, otto, conversation, say } = room();
    say(mira.id, "system", "no answer in time");

    expect(store.owesTurn(conversation.id, otto.id)).toBe(false);
  });

  it("still owes a turn when a system note lands after the message", () => {
    const { store, mira, otto, conversation, say } = room();
    say(mira.id, "agent", "a claim");
    say(mira.id, "system", "stopped");

    expect(store.owesTurn(conversation.id, otto.id)).toBe(true);
  });
});

describe("who is in a room", () => {
  function trio() {
    const store = new HubStore(":memory:");
    const made = ["mira", "otto", "nia"].map((handle) =>
      store.createAgent({ handle, displayName: handle }),
    );
    const [mira, otto, nia] = made;
    if (mira === undefined || otto === undefined || nia === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const conversation = store.createConversation(
      connectionId,
      "what is free will",
      undefined,
      mira.id,
    );
    if (conversation === undefined) throw new Error("conversation");
    return { store, mira, otto, nia, conversation };
  }

  it("starts a room with both ends of the connection it grew from", () => {
    const { store, mira, otto, conversation } = trio();

    expect(store.conversationParticipantIds(conversation.id)).toEqual([mira.id, otto.id]);
    expect(conversation.participants).toEqual(["mira", "otto"]);
  });

  it("grows, and the newcomer sees the room in their own list", () => {
    const { store, nia, conversation } = trio();
    expect(store.conversationsFor(nia.id)).toHaveLength(0);

    store.addMember(conversation.id, nia.id);

    expect(store.conversationsFor(nia.id).map((room) => room.id)).toEqual([conversation.id]);
    expect(store.conversation(conversation.id)?.participants).toEqual(["mira", "otto", "nia"]);
  });

  it("orders members by when they joined, which is the order turns are offered in", () => {
    const { store, mira, otto, nia, conversation } = trio();
    store.addMember(conversation.id, nia.id);

    expect(store.conversationParticipantIds(conversation.id)).toEqual([mira.id, otto.id, nia.id]);
  });

  it("shrinks, and the leaver stops seeing it", () => {
    const { store, otto, conversation } = trio();
    store.removeMember(conversation.id, otto.id);

    expect(store.isMember(conversation.id, otto.id)).toBe(false);
    expect(store.conversationsFor(otto.id)).toHaveLength(0);
    expect(store.conversation(conversation.id)?.participants).toEqual(["mira"]);
  });

  it("gives up a turn owed to somebody who has left", () => {
    const { store, otto, conversation } = trio();
    store.saveInFlight(conversation.id, otto.id, { pending: false, steered: false });

    store.removeMember(conversation.id, otto.id);

    expect(store.allInFlight()).toHaveLength(0);
  });

  it("adding somebody twice is not two memberships", () => {
    const { store, nia, conversation } = trio();
    store.addMember(conversation.id, nia.id);
    store.addMember(conversation.id, nia.id);

    expect(store.conversationParticipantIds(conversation.id)).toHaveLength(3);
  });

  it("tells a room with nobody left apart from one that does not exist", () => {
    const { store, mira, otto, conversation } = trio();
    store.removeMember(conversation.id, mira.id);
    store.removeMember(conversation.id, otto.id);

    expect(store.conversationParticipantIds(conversation.id)).toEqual([]);
    expect(store.conversationParticipantIds("cnv_nonexistent")).toBeUndefined();
  });
});

describe("deleting a room", () => {
  function trio() {
    const store = new HubStore(":memory:");
    const made = ["mira", "otto"].map((handle) => store.createAgent({ handle, displayName: handle }));
    const [mira, otto] = made;
    if (mira === undefined || otto === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const conversation = store.createConversation(connectionId, "what is free will");
    if (conversation === undefined) throw new Error("conversation");
    return { store, mira, otto, conversation };
  }

  it("erases the room, its members and everything said in it", () => {
    const { store, mira, otto, conversation } = trio();
    store.appendMessage({ conversationId: conversation.id, authorAgentId: mira.id, kind: "agent", text: "hi" });
    store.saveInFlight(conversation.id, otto.id, { pending: false, steered: false });

    store.deleteConversation(conversation.id);

    expect(store.conversation(conversation.id)).toBeUndefined();
    expect(store.conversationParticipantIds(conversation.id)).toBeUndefined();
    expect(store.conversationsFor(mira.id)).toHaveLength(0);
    expect(store.conversationsFor(otto.id)).toHaveLength(0);
    expect(store.allInFlight()).toHaveLength(0);
  });

  it("leaves an unrelated room alone", () => {
    const { store, mira, otto, conversation } = trio();
    const otherConnection = store.createConnection(mira.id, otto.id);
    const other = store.createConversation(otherConnection, "something else");
    if (other === undefined) throw new Error("conversation");

    store.deleteConversation(conversation.id);

    expect(store.conversation(other.id)).toBeDefined();
    expect(store.conversationsFor(mira.id).map((room) => room.id)).toEqual([other.id]);
  });
});

describe("what one agent is sent for its turn", () => {
  function room() {
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
    if (mira === undefined || otto === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const conversation = store.createConversation(connectionId, "what is free will", undefined, mira.id);
    if (conversation === undefined) throw new Error("conversation");
    const say = (agentId: string, text: string, kind: "agent" | "pass" | "system" = "agent") => {
      store.appendMessage({ conversationId: conversation.id, authorAgentId: agentId, kind, text });
    };
    const slice = (agentId: string) =>
      store.transcriptFor(conversation.id, agentId, TURN_OVERLAP);
    return { store, mira, otto, conversation, say, slice };
  }

  it("sends the whole room to an agent that has never spoken in it", () => {
    const { mira, otto, say, slice } = room();
    for (let index = 0; index < 4; index += 1) say(mira.id, `claim ${String(index)}`);

    const sent = slice(otto.id);
    expect(sent.messages).toHaveLength(4);
    expect(sent.earlier).toBe(0);
  });

  it("sends only what is new, once the agent has had its say", () => {
    const { mira, otto, say, slice } = room();
    for (let index = 0; index < 30; index += 1) say(mira.id, `claim ${String(index)}`);
    say(otto.id, "a rebuttal");
    say(mira.id, "a counter");

    // One unanswered message, plus the overlap. Not thirty-two: the agent is resuming a
    // thread that already holds them, and paying to repeat that is the whole bug.
    const sent = slice(otto.id);
    expect(sent.messages).toHaveLength(1 + TURN_OVERLAP);
    expect(sent.messages[sent.messages.length - 1]?.text).toBe("a counter");
    expect(sent.earlier).toBe(32 - (1 + TURN_OVERLAP));
  });

  it("costs the same on the hundredth turn as on the tenth", () => {
    const { mira, otto, say, slice } = room();
    let atTen = 0;
    for (let round = 0; round < 100; round += 1) {
      say(mira.id, `claim ${String(round)}`);
      const sent = slice(otto.id);
      if (round === 10) atTen = sent.messages.length;
      say(otto.id, `rebuttal ${String(round)}`);
      if (round === 99) expect(sent.messages.length).toBe(atTen);
    }
    expect(atTen).toBe(1 + TURN_OVERLAP);
  });

  it("gives an agent back from a long absence the recent argument, not all of it", () => {
    const { mira, otto, say, slice } = room();
    for (let index = 0; index < TURN_SLICE_MAX + 50; index += 1) say(mira.id, `claim ${String(index)}`);

    const sent = slice(otto.id);
    expect(sent.messages).toHaveLength(TURN_SLICE_MAX);
    expect(sent.earlier).toBe(50);
    expect(sent.messages[sent.messages.length - 1]?.text).toBe(`claim ${String(TURN_SLICE_MAX + 49)}`);
  });

  it("counts a pass as having had its say, so silence is not re-asked", () => {
    const { mira, otto, say, slice } = room();
    for (let index = 0; index < 10; index += 1) say(mira.id, `claim ${String(index)}`);
    say(otto.id, "", "pass");

    expect(slice(otto.id).messages).toHaveLength(TURN_OVERLAP);
  });

  it("is not fooled by a system note written in the agent's own name", () => {
    // The room attributes its own notes to whoever provoked them, so a failed turn writes a
    // "trouble" line in the agent's name. Counting that as the agent having spoken meant it
    // was never sent the message it had failed to answer.
    const { mira, otto, say, slice } = room();
    say(mira.id, "a claim");
    say(otto.id, "jazz daemon is not reachable", "system");

    const sent = slice(otto.id);
    expect(sent.messages.map((message) => message.text)).toContain("a claim");
  });

  it("still owes a turn after a failed one, whatever the room wrote in your name", () => {
    const { store, mira, otto, conversation, say } = room();
    say(mira.id, "a claim");
    say(otto.id, "jazz daemon is not reachable", "system");

    // Otto's model ran and failed. Nobody has answered @mira, so somebody still owes her
    // one — and it was this that stopped a reconnect retrying.
    expect(store.owesTurn(conversation.id, otto.id)).toBe(true);
  });

  it("sends nothing but the overlap when there is nothing new", () => {
    const { mira, otto, say, slice } = room();
    say(mira.id, "a claim");
    say(otto.id, "a rebuttal");

    const sent = slice(otto.id);
    expect(sent.messages.map((message) => message.text)).toEqual(["a claim", "a rebuttal"]);
  });

  it("gives at least one message even with no overlap allowed", () => {
    const { store, mira, otto, conversation, say } = room();
    say(mira.id, "a claim");
    say(otto.id, "a rebuttal");

    expect(store.transcriptFor(conversation.id, otto.id, 0).messages).toHaveLength(1);
  });
});

describe("an agent that has said goodbye", () => {
  function room() {
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
    if (mira === undefined || otto === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const conversation = store.createConversation(connectionId, "what is free will", undefined, mira.id);
    if (conversation === undefined) throw new Error("conversation");
    return { store, mira, otto, conversation };
  }

  it("starts with nobody having gone", () => {
    const { store, conversation } = room();
    expect(store.bowedOut(conversation.id)).toEqual([]);
    expect(store.conversation(conversation.id)?.bowedOut).toEqual([]);
  });

  it("is remembered, so a hub restart does not put it back to work", () => {
    // The whole reason this is a column and not a field on an in-memory map: an owner who
    // is no longer paying for their agent to talk must not have it wake up on a redeploy.
    const { store, mira, conversation } = room();
    store.setBowedOut(conversation.id, mira.id, true);

    expect(store.bowedOut(conversation.id)).toEqual([mira.id]);
    expect(store.conversation(conversation.id)?.bowedOut).toEqual(["mira"]);
  });

  it("comes back when its owner says so", () => {
    const { store, mira, conversation } = room();
    store.setBowedOut(conversation.id, mira.id, true);
    store.setBowedOut(conversation.id, mira.id, false);

    expect(store.bowedOut(conversation.id)).toEqual([]);
  });

  it("does not take the other member with it", () => {
    const { store, mira, otto, conversation } = room();
    store.setBowedOut(conversation.id, mira.id, true);

    expect(store.bowedOut(conversation.id)).not.toContain(otto.id);
    expect(store.isMember(conversation.id, mira.id)).toBe(true);
  });

  it("stops being anybody's problem once they leave the room", () => {
    const { store, mira, conversation } = room();
    store.setBowedOut(conversation.id, mira.id, true);
    store.removeMember(conversation.id, mira.id);

    expect(store.bowedOut(conversation.id)).toEqual([]);
  });
});

describe("agreeing to a conversation", () => {
  it("opens a room proposed, dispatching nothing yet", () => {
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
    if (mira === undefined || otto === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);

    const room = store.createConversation(connectionId, "review the lease", undefined, mira.id);
    expect(room?.state).toBe("proposed");
    expect(room?.proposedBy).toBe("mira");
  });

  it("goes live when the other side takes it up", () => {
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
    if (mira === undefined || otto === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const room = store.createConversation(connectionId, "review the lease", undefined, mira.id);
    if (room === undefined) throw new Error("room");

    expect(store.respondToConversation(room.id, otto.id, true)?.state).toBe("live");
  });

  it("refuses to let the proposer answer their own proposal", () => {
    // Otherwise the approval is decorative: whoever opened the room could wake the other
    // side's agent by accepting on their behalf.
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
    if (mira === undefined || otto === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const room = store.createConversation(connectionId, "review the lease", undefined, mira.id);
    if (room === undefined) throw new Error("room");

    expect(store.respondToConversation(room.id, mira.id, true)).toBeUndefined();
    expect(store.conversation(room.id)?.state).toBe("proposed");
  });

  it("closes a room that was turned down, rather than losing it", () => {
    // The proposer is owed the answer. A room that vanished would read as a bug on their end.
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
    if (mira === undefined || otto === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const room = store.createConversation(connectionId, "review the lease", undefined, mira.id);
    if (room === undefined) throw new Error("room");

    expect(store.respondToConversation(room.id, otto.id, false)?.state).toBe("closed");
  });

  it("ignores a second answer to a room already decided", () => {
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
    if (mira === undefined || otto === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const room = store.createConversation(connectionId, "review the lease", undefined, mira.id);
    if (room === undefined) throw new Error("room");
    store.respondToConversation(room.id, otto.id, true);

    expect(store.respondToConversation(room.id, otto.id, false)).toBeUndefined();
    expect(store.conversation(room.id)?.state).toBe("live");
  });

  it("refuses somebody who is not in the room at all", () => {
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
    const nia = store.createAgent({ handle: "nia", displayName: "Nia" });
    if (mira === undefined || otto === undefined || nia === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const room = store.createConversation(connectionId, "review the lease", undefined, mira.id);
    if (room === undefined) throw new Error("room");

    expect(store.respondToConversation(room.id, nia.id, true)).toBeUndefined();
  });
});
