import { describe, expect, it } from "bun:test";
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
      dispatch: "dsp_one",
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
        dispatch: "dsp_one",
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
    store.saveInFlight(conversation.id, mira.id, { dispatch: "dsp_one", pending: false, steered: false });
    const first = store.allInFlight()[0]?.dispatchedAt;

    await Bun.sleep(5);
    store.saveInFlight(conversation.id, mira.id, { dispatch: "dsp_one", pending: true, steered: false });

    // The deadline a recovered turn gets is measured from when the money was spent, so an
    // update must not quietly restart that clock.
    expect(store.allInFlight()[0]?.dispatchedAt).toBe(first);
    expect(store.allInFlight()[0]?.entry.pending).toBe(true);
  });

  it("leaves no queued steer behind when there was none", () => {
    const { store, mira, conversation } = setup(0);
    store.saveInFlight(conversation.id, mira.id, { dispatch: "dsp_one", pending: false, steered: false });

    expect(store.allInFlight()[0]?.entry).toEqual({ dispatch: "dsp_one", pending: false, steered: false });
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
    store.saveInFlight(conversation.id, otto.id, { dispatch: "dsp_otto", pending: false, steered: false });

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
    store.saveInFlight(conversation.id, otto.id, { dispatch: "dsp_otto", pending: false, steered: false });

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

describe("the dispatch ledger", () => {
  function room() {
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
    if (mira === undefined || otto === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const conversation = store.createConversation(connectionId, "find a time");
    if (conversation === undefined) throw new Error("conversation");
    return { store, mira, otto, conversation };
  }

  it("knows nothing about a turn it never handed out", () => {
    const { store, mira, conversation } = room();

    expect(store.dispatchState(conversation.id, mira.id, "invented")).toBe("unknown");
  });

  it("lets a dispatch be spent exactly once", () => {
    const { store, mira, conversation } = room();
    store.recordDispatch(conversation.id, mira.id, "dsp_one");

    expect(store.dispatchState(conversation.id, mira.id, "dsp_one")).toBe("open");
    expect(store.settleDispatch(conversation.id, mira.id, "dsp_one")).toBe(true);
    expect(store.dispatchState(conversation.id, mira.id, "dsp_one")).toBe("settled");
    expect(store.settleDispatch(conversation.id, mira.id, "dsp_one")).toBe(false);
  });

  it("will not let one member of a room spend another member's turn", () => {
    const { store, mira, otto, conversation } = room();
    store.recordDispatch(conversation.id, mira.id, "dsp_one");

    // The id is not a secret from @otto — it travels in the signature, because the far side
    // needs it to check one. So the check cannot be \"whoever quotes this id\".
    expect(store.dispatchState(conversation.id, otto.id, "dsp_one")).toBe("unknown");
    expect(store.settleDispatch(conversation.id, otto.id, "dsp_one")).toBe(false);
    expect(store.dispatchState(conversation.id, mira.id, "dsp_one")).toBe("open");
  });

  it("goes with the room it belonged to", () => {
    const { store, mira, conversation } = room();
    store.recordDispatch(conversation.id, mira.id, "dsp_one");
    store.deleteConversation(conversation.id);

    expect(store.dispatchState(conversation.id, mira.id, "dsp_one")).toBe("unknown");
  });
});

describe("a nonce that has already been used", () => {
  function room() {
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
    if (mira === undefined || otto === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const conversation = store.createConversation(connectionId, "find a time");
    if (conversation === undefined) throw new Error("conversation");
    const signature = (nonce: string, dispatch = "dsp_one") => ({
      did: "did:key:zMira",
      authoredAt: "2026-09-04T10:00:00.000Z",
      nonce,
      prev: "",
      dispatch,
      value: "sig",
    });
    return { store, mira, otto, conversation, signature };
  }

  it("is reported before anything is written", () => {
    const { store, mira, conversation, signature } = room();
    store.appendMessage({
      conversationId: conversation.id,
      authorAgentId: mira.id,
      kind: "agent",
      text: "the original",
      signature: signature("n1"),
    });

    expect(store.nonceUsed(conversation.id, "did:key:zMira", "n1")).toBe(true);
    expect(store.nonceUsed(conversation.id, "did:key:zMira", "n2")).toBe(false);
  });

  it("cannot be appended a second time even if the check is skipped", () => {
    const { store, mira, conversation, signature } = room();
    store.appendMessage({
      conversationId: conversation.id,
      authorAgentId: mira.id,
      kind: "agent",
      text: "the original",
      signature: signature("n1"),
    });

    // The database is the enforcement, not the lookup above: a check some future caller
    // forgets to make is not a defence against a replayed frame.
    expect(() =>
      store.appendMessage({
        conversationId: conversation.id,
        authorAgentId: mira.id,
        kind: "agent",
        text: "the original",
        signature: signature("n1"),
      }),
    ).toThrow();
    expect(store.transcript(conversation.id, 20)).toHaveLength(1);
  });

  it("is only spent within its own room, and only for its own author", () => {
    const { store, mira, otto, conversation, signature } = room();
    store.appendMessage({
      conversationId: conversation.id,
      authorAgentId: mira.id,
      kind: "agent",
      text: "the original",
      signature: signature("n1"),
    });

    // Two authors can pick the same nonce without either of them replaying anything, and so
    // can the same author in a different room. Only the triple is a repeat.
    expect(() =>
      store.appendMessage({
        conversationId: conversation.id,
        authorAgentId: otto.id,
        kind: "agent",
        text: "mine, coincidentally",
        signature: { ...signature("n1"), did: "did:key:zOtto" },
      }),
    ).not.toThrow();
    expect(store.transcript(conversation.id, 20)).toHaveLength(2);
  });
});

describe("erasing a room for everyone", () => {
  function trio() {
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
    const nia = store.createAgent({ handle: "nia", displayName: "Nia" });
    if (mira === undefined || otto === undefined || nia === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const conversation = store.createConversation(connectionId, "find a time");
    if (conversation === undefined) throw new Error("conversation");
    return { store, mira, otto, nia, conversation };
  }

  it("needs every current member, not the first one to ask", () => {
    const { store, mira, otto, conversation } = trio();

    expect(store.askErase(conversation.id, mira.id)).toBe(true);
    expect(store.everyoneAskedErase(conversation.id)).toBe(false);
    expect(store.conversation(conversation.id)?.eraseAsked).toEqual(["mira"]);

    expect(store.askErase(conversation.id, otto.id)).toBe(true);
    expect(store.everyoneAskedErase(conversation.id)).toBe(true);
  });

  it("does not count a repeated ask as a second vote", () => {
    const { store, mira, conversation } = trio();
    expect(store.askErase(conversation.id, mira.id)).toBe(true);
    expect(store.askErase(conversation.id, mira.id)).toBe(false);

    expect(store.everyoneAskedErase(conversation.id)).toBe(false);
    expect(store.conversation(conversation.id)?.eraseAsked).toEqual(["mira"]);
  });

  it("takes a newcomer's agreement too, since they are now in the room", () => {
    const { store, mira, otto, nia, conversation } = trio();
    store.askErase(conversation.id, mira.id);
    store.askErase(conversation.id, otto.id);
    expect(store.everyoneAskedErase(conversation.id)).toBe(true);

    store.addMember(conversation.id, nia.id);
    expect(store.everyoneAskedErase(conversation.id)).toBe(false);
  });

  it("stops waiting on somebody who has left", () => {
    const { store, mira, otto, conversation } = trio();
    store.askErase(conversation.id, mira.id);
    expect(store.everyoneAskedErase(conversation.id)).toBe(false);

    // Leaving reduces who is left to agree, which is what keeps this reachable rather than
    // a room frozen forever by one member who never comes back.
    store.removeMember(conversation.id, otto.id);
    expect(store.everyoneAskedErase(conversation.id)).toBe(true);
  });
});

describe("writing several things as one", () => {
  it("keeps none of them when the work throws", () => {
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
    if (mira === undefined || otto === undefined) throw new Error("agents");
    const connectionId = store.createConnection(mira.id, otto.id);
    const conversation = store.createConversation(connectionId, "find a time");
    if (conversation === undefined) throw new Error("conversation");

    // The shape of the turn transition: a message and the charge for it are one fact, and a
    // process that died between them left a room with a message whose turn was still in
    // flight — charged, unanswerable, and invisible.
    expect(() =>
      store.transaction(() => {
        store.appendMessage({
          conversationId: conversation.id,
          authorAgentId: mira.id,
          kind: "agent",
          text: "half a turn",
        });
        store.setSpend(conversation.id, 0.25, false);
        throw new Error("the process died here");
      }),
    ).toThrow("the process died here");

    expect(store.transcript(conversation.id, 20)).toHaveLength(0);
    expect(store.spend(conversation.id).usd).toBe(0);
  });
});
