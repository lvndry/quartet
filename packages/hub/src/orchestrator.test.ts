import { describe, expect, it } from "bun:test";
import type { ServerFrame } from "@quartet/protocol";
import { HubStore } from "./db";
import { Orchestrator } from "./orchestrator";

function setup() {
  const store = new HubStore(":memory:");
  const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
  const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
  if (mira === undefined || otto === undefined) throw new Error("agents");
  const connectionId = store.createConnection(mira.id, otto.id);
  const conversation = store.createConversation(connectionId, "find a time");
  if (conversation === undefined) throw new Error("conversation");
  const frames: ServerFrame[] = [];
  const online = new Set([mira.id, otto.id]);
  const orchestrator = new Orchestrator(
    store,
    (_agentId, frame) => {
      frames.push(frame);
    },
    (agentId) => online.has(agentId),
  );
  return { store, mira, otto, conversation, frames, orchestrator, online };
}

describe("orchestrator write path", () => {
  it("persists spend so a cost cap can bind", () => {
    const { store, mira, conversation, orchestrator } = setup();
    orchestrator.setLimit(conversation.id, { kind: "cost", usd: 0.05 });
    orchestrator.onSpend(conversation.id, 0.04, false);

    expect(store.spend(conversation.id).usd).toBeCloseTo(0.04);
    const again = store.conversation(conversation.id);
    expect(again?.spentUSD).toBeCloseTo(0.04);

    orchestrator.onNudge(conversation.id, mira.id, "say something");
    orchestrator.onSpend(conversation.id, 0.02, false);
    expect(store.spend(conversation.id).usd).toBeCloseTo(0.06);
  });

  it("replays an in-flight turn after hello without charging again", () => {
    const { store, mira, conversation, frames, orchestrator } = setup();
    const before = store.budget(conversation.id);
    orchestrator.onNudge(conversation.id, mira.id, "start on this");
    const afterDispatch = store.budget(conversation.id);
    expect(afterDispatch).toBe(before - 1);
    expect(frames.filter((frame) => frame.t === "turn")).toHaveLength(1);

    orchestrator.replayTurns(mira.id);
    expect(store.budget(conversation.id)).toBe(afterDispatch);
    const turns = frames.filter((frame) => frame.t === "turn");
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ t: "turn", conversationId: conversation.id, steer: "start on this" });
  });
});

/**
 * A restart, modelled as a second orchestrator over the same database.
 *
 * That is exactly what survives one: the socket registry and the turn bookkeeping are
 * per-process, the store is the durable half. The turn bookkeeping used to be per-process
 * too, while the charge for it went to disk — so a room came back paid up and silent.
 */
function restart(store: HubStore) {
  const frames: ServerFrame[] = [];
  const orchestrator = new Orchestrator(
    store,
    (_agentId, frame) => {
      frames.push(frame);
    },
    () => true,
  );
  return { orchestrator, frames };
}

describe("a hub that restarts mid-turn", () => {
  it("still knows the turn is owed, and does not charge for it twice", () => {
    const { store, mira, conversation, orchestrator } = setup();
    orchestrator.onNudge(conversation.id, mira.id, "start on this");
    const charged = store.budget(conversation.id);

    const revived = restart(store);
    revived.orchestrator.recover();
    expect(revived.orchestrator.hasTurn(conversation.id, mira.id)).toBe(true);

    revived.orchestrator.replayTurns(mira.id);
    expect(store.budget(conversation.id)).toBe(charged);
    const turns = revived.frames.filter((frame) => frame.t === "turn");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ steer: "start on this" });
  });

  it("says so in the room when a recovered turn is already past its deadline", async () => {
    const { store, mira, conversation, orchestrator } = setup();
    orchestrator.onNudge(conversation.id, mira.id, "start on this");

    const revived = restart(store);
    // Long enough after the dispatch that the deadline has gone. Arms at zero and fires on
    // the next tick, which is why this waits a tick rather than three minutes.
    revived.orchestrator.recover(Date.now() + 60 * 60_000);
    await Bun.sleep(5);

    expect(revived.orchestrator.hasTurn(conversation.id, mira.id)).toBe(false);
    const said = store.transcript(conversation.id, 20);
    expect(said.some((message) => message.kind === "system" && message.text === "no answer in time")).toBe(true);
  });

  it("forgets a turn that settled before the restart", () => {
    const { store, mira, conversation, orchestrator } = setup();
    orchestrator.onNudge(conversation.id, mira.id, "start on this");
    orchestrator.onTurnSettled(conversation.id, mira.id, "spoke");

    const revived = restart(store);
    revived.orchestrator.recover();

    expect(revived.orchestrator.hasTurn(conversation.id, mira.id)).toBe(false);
    revived.orchestrator.replayTurns(mira.id);
    expect(revived.frames.filter((frame) => frame.t === "turn")).toHaveLength(0);
  });

  it("carries a room's state across, so a goodbye stays a goodbye", () => {
    const { store, mira, otto, conversation, orchestrator } = setup();
    orchestrator.onNudge(conversation.id, mira.id, "wrap this up");
    const closing = store.appendMessage({
      conversationId: conversation.id,
      authorAgentId: mira.id,
      kind: "agent",
      text: "settled, then. bye",
    });
    if (closing === undefined) throw new Error("message");
    orchestrator.closeWith(conversation.id, mira.id, closing);
    // One goodbye takes @mira out; the room is still @otto's to speak in.
    expect(store.bowedOut(conversation.id)).toEqual([mira.id]);
    expect(store.roomState(conversation.id)).toBe("live");

    orchestrator.onTurnSettled(conversation.id, otto.id, "closed");
    expect(store.roomState(conversation.id)).toBe("closed");

    const revived = restart(store);
    revived.orchestrator.recover();
    revived.orchestrator.setLimit(conversation.id, { kind: "turns", turns: 30 });

    expect(store.roomState(conversation.id)).toBe("closed");
    revived.orchestrator.onNudge(conversation.id, otto.id, "actually, one more thing");
    expect(revived.frames.filter((frame) => frame.t === "turn")).toHaveLength(0);

    revived.orchestrator.reopen(conversation.id);
    revived.orchestrator.onNudge(conversation.id, otto.id, "actually, one more thing");
    expect(revived.frames.filter((frame) => frame.t === "turn")).toHaveLength(1);
  });
});

describe("an agent whose bridge was down", () => {
  it("answers the message it missed once it reconnects", () => {
    const { store, mira, otto, conversation, frames, orchestrator, online } = setup();
    online.delete(otto.id);

    const said = store.appendMessage({
      conversationId: conversation.id,
      authorAgentId: mira.id,
      kind: "agent",
      text: "free will is compatible with determinism",
    });
    if (said === undefined) throw new Error("message");
    const before = store.budget(conversation.id);
    orchestrator.onMessage(conversation.id, mira.id, said);

    // Nothing was dispatched and nothing was charged: there was no socket to dispatch to.
    expect(frames.filter((frame) => frame.t === "turn")).toHaveLength(0);
    expect(store.budget(conversation.id)).toBe(before);

    online.add(otto.id);
    orchestrator.replayTurns(otto.id);
    orchestrator.onArrived(otto.id);

    const turns = frames.filter((frame) => frame.t === "turn");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ conversationId: conversation.id });
    expect(store.budget(conversation.id)).toBe(before - 1);
  });

  it("does not ask twice when it reconnects again", () => {
    const { store, mira, otto, conversation, frames, orchestrator, online } = setup();
    online.delete(otto.id);
    const said = store.appendMessage({
      conversationId: conversation.id,
      authorAgentId: mira.id,
      kind: "agent",
      text: "a claim",
    });
    if (said === undefined) throw new Error("message");
    orchestrator.onMessage(conversation.id, mira.id, said);

    online.add(otto.id);
    orchestrator.onArrived(otto.id);
    const charged = store.budget(conversation.id);

    // A flapping connection must not spend a turn per reconnect. The first turn is still in
    // flight, so this is replayTurns' business, not a fresh dispatch.
    orchestrator.onArrived(otto.id);
    expect(store.budget(conversation.id)).toBe(charged);
    expect(frames.filter((frame) => frame.t === "turn")).toHaveLength(1);
  });

  it("asks for nothing when the room was already up to date", () => {
    const { otto, frames, orchestrator } = setup();
    orchestrator.onArrived(otto.id);

    expect(frames.filter((frame) => frame.t === "turn")).toHaveLength(0);
  });

  it("leaves a closed room closed when somebody comes back to it", () => {
    const { store, mira, otto, conversation, frames, orchestrator, online } = setup();
    online.delete(otto.id);
    const said = store.appendMessage({
      conversationId: conversation.id,
      authorAgentId: mira.id,
      kind: "agent",
      text: "settled, then. bye",
    });
    if (said === undefined) throw new Error("message");
    orchestrator.onMessage(conversation.id, mira.id, said);
    orchestrator.closeWith(conversation.id, mira.id, said);
    // Both gone, so the room really is closed rather than merely quiet on one side.
    orchestrator.onTurnSettled(conversation.id, otto.id, "closed");

    online.add(otto.id);
    orchestrator.onArrived(otto.id);

    expect(frames.filter((frame) => frame.t === "turn")).toHaveLength(0);
    expect(store.roomState(conversation.id)).toBe("closed");
  });
});

describe("a room somebody was brought into", () => {
  function trio() {
    const base = setup();
    const nia = base.store.createAgent({ handle: "nia", displayName: "Nia" });
    if (nia === undefined) throw new Error("agent");
    base.online.add(nia.id);
    return { ...base, nia };
  }

  const dispatchedTo = (frames: ServerFrame[]) =>
    frames.filter((frame) => frame.t === "turn").length;

  it("wakes both of the others when one agent speaks", () => {
    const { store, mira, conversation, frames, orchestrator, nia } = trio();
    store.addMember(conversation.id, nia.id);
    const before = store.budget(conversation.id);

    const said = store.appendMessage({
      conversationId: conversation.id,
      authorAgentId: mira.id,
      kind: "agent",
      text: "free will is compatible with determinism",
    });
    if (said === undefined) throw new Error("message");
    orchestrator.onMessage(conversation.id, mira.id, said);

    expect(dispatchedTo(frames)).toBe(2);
    expect(store.budget(conversation.id)).toBe(before - 2);
  });

  it("asks the newcomer for a turn, since they have heard none of it", () => {
    const { store, mira, conversation, frames, orchestrator, nia } = trio();
    const said = store.appendMessage({
      conversationId: conversation.id,
      authorAgentId: mira.id,
      kind: "agent",
      text: "a claim",
    });
    if (said === undefined) throw new Error("message");
    orchestrator.onMessage(conversation.id, mira.id, said);
    const dispatchedBefore = dispatchedTo(frames);

    store.addMember(conversation.id, nia.id);
    orchestrator.onJoined(conversation.id, nia.id);

    expect(dispatchedTo(frames)).toBe(dispatchedBefore + 1);
  });

  it("closes the room when leaving would leave one agent on its own", () => {
    const { store, otto, conversation, orchestrator } = trio();
    store.removeMember(conversation.id, otto.id);
    orchestrator.onLeft(conversation.id, otto.id);

    expect(store.roomState(conversation.id)).toBe("closed");
  });

  it("keeps a three-way room running when one of them walks out", () => {
    const { store, otto, conversation, orchestrator, nia } = trio();
    store.addMember(conversation.id, nia.id);

    store.removeMember(conversation.id, otto.id);
    orchestrator.onLeft(conversation.id, otto.id);

    expect(store.roomState(conversation.id)).toBe("live");
    expect(store.conversationParticipantIds(conversation.id)).toHaveLength(2);
  });

  it("stops dispatching to somebody who has left", () => {
    const { store, mira, otto, conversation, frames, orchestrator, nia } = trio();
    store.addMember(conversation.id, nia.id);
    store.removeMember(conversation.id, otto.id);
    orchestrator.onLeft(conversation.id, otto.id);

    const said = store.appendMessage({
      conversationId: conversation.id,
      authorAgentId: mira.id,
      kind: "agent",
      text: "still here?",
    });
    if (said === undefined) throw new Error("message");
    frames.length = 0;
    orchestrator.onMessage(conversation.id, mira.id, said);

    expect(dispatchedTo(frames)).toBe(1);
  });
});

describe("a turn that takes minutes", () => {
  it("gets its deadline back each time the bridge says it is still working", async () => {
    // The deadline is for noticing a bridge that has gone away, not for capping how long an
    // agent may think. Without this, a turn that read a calendar and searched the web tripped
    // it every time and the room announced "no answer in time" over a live run.
    const { store, mira, conversation, orchestrator } = setup();
    orchestrator.onNudge(conversation.id, mira.id, "take your time");
    expect(orchestrator.hasTurn(conversation.id, mira.id)).toBe(true);

    // Recovered with a dispatch time long past its deadline, then heartbeaten: the turn
    // survives, where without the heartbeat it would be given up on immediately.
    const revived = restart(store);
    revived.orchestrator.recover(Date.now() + 60 * 60_000);
    revived.orchestrator.onProgress(conversation.id, mira.id);
    await Bun.sleep(5);

    expect(revived.orchestrator.hasTurn(conversation.id, mira.id)).toBe(true);
    const said = store.transcript(conversation.id, 20);
    expect(said.some((message) => message.text === "no answer in time")).toBe(false);
  });

  it("ignores a heartbeat for a turn nobody is waiting on", () => {
    const { conversation, mira, orchestrator } = setup();
    // No dispatch, so nothing to keep alive. This must not invent a deadline.
    expect(() => orchestrator.onProgress(conversation.id, mira.id)).not.toThrow();
    expect(orchestrator.hasTurn(conversation.id, mira.id)).toBe(false);
  });

  it("still delivers an answer that arrives after the room gave up", async () => {
    const { store, mira, otto, conversation, orchestrator } = setup();
    orchestrator.onNudge(conversation.id, mira.id, "go");

    // Let the deadline actually fire, the way it does when a bridge goes quiet.
    const revived = restart(store);
    revived.orchestrator.recover(Date.now() + 60 * 60_000);
    await Bun.sleep(5);
    expect(revived.orchestrator.hasTurn(conversation.id, mira.id)).toBe(false);

    // Then the daemon finishes anyway. The words crossed, so they belong in the room, and
    // @otto is still owed a reply to them.
    const late = store.appendMessage({
      conversationId: conversation.id,
      authorAgentId: mira.id,
      kind: "agent",
      text: "sorry, that took a while",
    });
    if (late === undefined) throw new Error("message");
    revived.orchestrator.onTurnSettled(conversation.id, mira.id, "spoke");
    revived.orchestrator.onMessage(conversation.id, mira.id, late);

    const delivered = revived.frames.some(
      (frame) => frame.t === "appended" && frame.message.text === "sorry, that took a while",
    );
    expect(delivered).toBe(true);
    // And it wakes @otto, because a late answer is still an answer he has not heard.
    const woken = revived.frames.some((frame) => frame.t === "turn");
    expect(woken).toBe(true);
    void otto;
  });
});
