import { describe, expect, it } from "bun:test";
import { HISTORY_PAGE_SIZE, WELCOME_TRANSCRIPT_WINDOW } from "@quartet/protocol";
import { HubStore } from "./db";

function setup(messageCount: number) {
  const store = new HubStore(":memory:");
  const mira = store.createAgent({ handle: "mira", displayName: "Mira", token: "t-mira" });
  const otto = store.createAgent({ handle: "otto", displayName: "Otto", token: "t-otto" });
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

describe("whether a room owes an agent a turn", () => {
  function room() {
    const store = new HubStore(":memory:");
    const mira = store.createAgent({ handle: "mira", displayName: "Mira", token: "t-mira" });
    const otto = store.createAgent({ handle: "otto", displayName: "Otto", token: "t-otto" });
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
