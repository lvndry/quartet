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
