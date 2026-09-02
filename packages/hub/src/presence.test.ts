import { describe, expect, it } from "bun:test";
import type { ServerFrame } from "@quartet/protocol";
import { HubStore } from "./db";
import { RoomPresence } from "./presence";

function setup() {
  const store = new HubStore(":memory:");
  const mira = store.createAgent({ handle: "mira", displayName: "Mira", token: "t-mira" });
  const otto = store.createAgent({ handle: "otto", displayName: "Otto", token: "t-otto" });
  if (mira === undefined || otto === undefined) throw new Error("agents");
  const connectionId = store.createConnection(mira.id, otto.id);
  const conversation = store.createConversation(connectionId, "find a time");
  if (conversation === undefined) throw new Error("conversation");

  const frames: { agentId: string; frame: ServerFrame }[] = [];
  const online = new Set([mira.id, otto.id]);
  const thinking = new Set<string>();
  const presence = new RoomPresence(
    store,
    (agentId, frame) => {
      frames.push({ agentId, frame });
    },
    (agentId) => online.has(agentId),
    (conversationId, agentId) => thinking.has(`${conversationId}::${agentId}`),
  );
  return { mira, otto, conversation, frames, online, thinking, presence };
}

function lastPresence(
  frames: { agentId: string; frame: ServerFrame }[],
  agentId: string,
): Extract<ServerFrame, { t: "presence" }> {
  const found = [...frames]
    .reverse()
    .find((entry) => entry.agentId === agentId && entry.frame.t === "presence");
  if (found === undefined || found.frame.t !== "presence") throw new Error("no presence");
  return found.frame;
}

describe("room presence", () => {
  it("tells the other side when someone is watching this conversation", () => {
    const { mira, otto, conversation, frames, presence } = setup();
    presence.watch(mira.id, conversation.id);

    const ottoSees = lastPresence(frames, otto.id);
    expect(ottoSees.other.handle).toBe("mira");
    expect(ottoSees.other.watching).toBe(true);
    expect(ottoSees.other.online).toBe(true);
    expect(ottoSees.other.thinking).toBe(false);
  });

  it("shows their agent thinking, with a stable since", () => {
    const { mira, otto, conversation, frames, thinking, presence } = setup();
    thinking.add(`${conversation.id}::${mira.id}`);
    presence.announce(conversation.id);
    const first = lastPresence(frames, otto.id);
    expect(first.other.thinking).toBe(true);
    expect(first.other.since).toBeDefined();

    presence.announce(conversation.id);
    const again = lastPresence(frames, otto.id);
    expect(again.other.since).toBe(first.other.since);
  });

  it("clears watching and online when their bridge drops", () => {
    const { mira, otto, conversation, frames, online, presence } = setup();
    presence.watch(mira.id, conversation.id);
    online.delete(mira.id);
    presence.clear(mira.id);

    const ottoSees = lastPresence(frames, otto.id);
    expect(ottoSees.other.watching).toBe(false);
    expect(ottoSees.other.online).toBe(false);
  });
});
