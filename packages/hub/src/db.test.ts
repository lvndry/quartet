import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_PAGE_SIZE, WELCOME_TRANSCRIPT_WINDOW } from "@quartet/protocol";
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
