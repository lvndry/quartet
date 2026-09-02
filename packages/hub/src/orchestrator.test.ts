import { describe, expect, it } from "bun:test";
import type { ServerFrame } from "@quartet/protocol";
import { HubStore } from "./db";
import { Orchestrator } from "./orchestrator";

function setup() {
  const store = new HubStore(":memory:");
  const mira = store.createAgent({ handle: "mira", displayName: "Mira", token: "t-mira" });
  const otto = store.createAgent({ handle: "otto", displayName: "Otto", token: "t-otto" });
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
  return { store, mira, otto, conversation, frames, orchestrator };
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
