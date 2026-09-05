import { describe, expect, it } from "bun:test";
import type { PeerPresence, ServerFrame } from "@quartet/protocol";
import { generateKeypair } from "@quartet/identity";
import { HubStore } from "./db";
import { RoomPresence } from "./presence";

function setup() {
  const store = new HubStore(":memory:");
  const mira = store.createAgent({ handle: "mira", displayName: "Mira" , did: generateKeypair().did });
  const otto = store.createAgent({ handle: "otto", displayName: "Otto" , did: generateKeypair().did });
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
  return { store, mira, otto, conversation, frames, online, thinking, presence };
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

/** The one other party, for the two-party rooms most of these tests use. */
function soleOther(
  frames: { agentId: string; frame: ServerFrame }[],
  agentId: string,
): PeerPresence {
  const { others } = lastPresence(frames, agentId);
  const only = others[0];
  if (only === undefined || others.length !== 1) {
    throw new Error(`expected one other party, got ${String(others.length)}`);
  }
  return only;
}

describe("room presence", () => {
  it("tells the other side when someone is watching this conversation", () => {
    const { mira, otto, conversation, frames, presence } = setup();
    presence.watch(mira.id, conversation.id);

    const mira_ = soleOther(frames, otto.id);
    expect(mira_.did).toBe(mira.did);
    expect(mira_.watching).toBe(true);
    expect(mira_.online).toBe(true);
    expect(mira_.thinking).toBe(false);
  });

  it("shows their agent thinking, with a stable since", () => {
    const { mira, otto, conversation, frames, thinking, presence } = setup();
    thinking.add(`${conversation.id}::${mira.id}`);
    presence.announce(conversation.id);
    const first = soleOther(frames, otto.id);
    expect(first.thinking).toBe(true);
    expect(first.since).toBeDefined();

    presence.announce(conversation.id);
    expect(soleOther(frames, otto.id).since).toBe(first.since);
  });

  it("clears watching and online when their bridge drops", () => {
    const { mira, otto, conversation, frames, online, presence } = setup();
    presence.watch(mira.id, conversation.id);
    online.delete(mira.id);
    presence.clear(mira.id);

    const mira_ = soleOther(frames, otto.id);
    expect(mira_.watching).toBe(false);
    expect(mira_.online).toBe(false);
  });
});

describe("presence in a room of three", () => {
  it("tells each member about both of the others, and never about themselves", () => {
    const { store, mira, otto, conversation, frames, online, presence } = setup();
    const nia = store.createAgent({ handle: "nia", displayName: "Nia" , did: generateKeypair().did });
    if (nia === undefined) throw new Error("agent");
    store.addMember(conversation.id, nia.id);
    online.add(nia.id);

    presence.announce(conversation.id);

    const seenBy = (agentId: string) =>
      lastPresence(frames, agentId)
        .others.map((entry) => entry.did)
        .sort();

    expect(seenBy(mira.id)).toEqual([nia.did, otto.did].sort());
    expect(seenBy(otto.id)).toEqual([mira.did, nia.did].sort());
    expect(seenBy(nia.id)).toEqual([mira.did, otto.did].sort());
  });

  it("shows one member thinking without saying it of the others", () => {
    const { store, mira, otto, conversation, frames, online, thinking, presence } = setup();
    const nia = store.createAgent({ handle: "nia", displayName: "Nia", did: generateKeypair().did });
    if (nia === undefined) throw new Error("agent");
    store.addMember(conversation.id, nia.id);
    online.add(nia.id);
    thinking.add(`${conversation.id}::${nia.id}`);

    presence.announce(conversation.id);

    const miraSees = lastPresence(frames, mira.id).others;
    expect(miraSees.find((entry) => entry.did === nia.did)?.thinking).toBe(true);
    expect(miraSees.find((entry) => entry.did === otto.did)?.thinking).toBe(false);
  });

  it("drops somebody from the list once they leave", () => {
    const { store, mira, otto, conversation, frames, presence } = setup();
    store.removeMember(conversation.id, otto.id);

    presence.announce(conversation.id);

    expect(lastPresence(frames, mira.id).others).toHaveLength(0);
  });
});

describe("what an agent is doing", () => {
  it("reaches the other side while the turn is running", () => {
    const { mira, otto, conversation, frames, thinking, presence } = setup();
    thinking.add(`${conversation.id}::${mira.id}`);
    presence.note(conversation.id, mira.id, "read_file");

    // "@mira's agent is thinking" for four minutes is indistinguishable from a broken
    // room. This is the one sentence that tells them apart.
    expect(soleOther(frames, otto.id).doing).toBe("read_file");
  });

  it("is dropped when the turn ends, so a finished tool does not sit there looking live", () => {
    const { mira, otto, conversation, frames, thinking, presence } = setup();
    thinking.add(`${conversation.id}::${mira.id}`);
    presence.note(conversation.id, mira.id, "web_search");
    expect(soleOther(frames, otto.id).doing).toBe("web_search");

    thinking.delete(`${conversation.id}::${mira.id}`);
    presence.announce(conversation.id);
    expect(soleOther(frames, otto.id).doing).toBeUndefined();
  });

  it("is not shown for an agent that is not mid-turn", () => {
    const { mira, otto, conversation, frames, presence } = setup();
    presence.note(conversation.id, mira.id, "read_file");

    expect(soleOther(frames, otto.id).thinking).toBe(false);
    expect(soleOther(frames, otto.id).doing).toBeUndefined();
  });
});
