import { describe, expect, it } from "bun:test";
import type { ServerFrame, Signature } from "@quartet/protocol";
import { HubStore } from "./db";
import { Orchestrator } from "./orchestrator";

function setup() {
  const store = new HubStore(":memory:");
  const mira = store.createAgent({ handle: "mira", displayName: "Mira" });
  const otto = store.createAgent({ handle: "otto", displayName: "Otto" });
  if (mira === undefined || otto === undefined) throw new Error("agents");
  const connectionId = store.createConnection(mira.id, otto.id);
  const proposal = store.createConversation(connectionId, "find a time");
  if (proposal === undefined) throw new Error("conversation");
  // Rooms open proposed and dispatch nothing until the other side takes them up. These
  // tests are about what happens once one is running, so it starts where they begin.
  store.setState(proposal.id, "live");
  const conversation = store.conversation(proposal.id);
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

/** The turn the hub is currently holding for this agent — what its bridge would answer under. */
function heldDispatch(store: HubStore, conversationId: string, agentId: string): string {
  const entry = store
    .allInFlight()
    .find((row) => row.conversationId === conversationId && row.agentId === agentId);
  if (entry === undefined) throw new Error("no turn is in flight for that agent");
  return entry.entry.dispatch;
}

let nonces = 0;

/**
 * A signature the orchestrator will store but never check.
 *
 * Verification is the hub's door, not this layer's — see `signatureFor` in `main.ts`. What
 * matters here is that each one carries a fresh nonce, because the database refuses a second
 * message under a nonce a room has already seen.
 */
function stubSignature(dispatch: string): Signature {
  nonces += 1;
  return {
    did: "did:key:zTest",
    authoredAt: new Date().toISOString(),
    nonce: `nonce-${String(nonces)}`,
    prev: "",
    dispatch,
    value: "not-verified-at-this-layer",
  };
}

/** What the hub does when a bridge answers a turn. */
function answer(
  store: HubStore,
  orchestrator: Orchestrator,
  conversationId: string,
  agentId: string,
  options: {
    text?: string;
    kind?: "agent" | "pass";
    closing?: boolean;
    costUSD?: number;
    dispatch?: string;
  } = {},
) {
  const dispatch = options.dispatch ?? heldDispatch(store, conversationId, agentId);
  return orchestrator.said(conversationId, agentId, {
    kind: options.kind ?? "agent",
    text: options.text ?? "something",
    signature: stubSignature(dispatch),
    dispatch,
    ...(options.costUSD !== undefined ? { costUSD: options.costUSD } : {}),
    costIncomplete: false,
    closing: options.closing ?? false,
  });
}

describe("orchestrator write path", () => {
  it("persists spend so a cost cap can bind", () => {
    const { store, mira, conversation, orchestrator } = setup();
    orchestrator.setLimit(conversation.id, { kind: "cost", usd: 0.05 });

    orchestrator.onNudge(conversation.id, mira.id, "say something");
    answer(store, orchestrator, conversation.id, mira.id, { costUSD: 0.04 });

    expect(store.spend(conversation.id).usd).toBeCloseTo(0.04);
    expect(store.conversation(conversation.id)?.spentUSD).toBeCloseTo(0.04);

    orchestrator.onNudge(conversation.id, mira.id, "and again");
    answer(store, orchestrator, conversation.id, mira.id, { costUSD: 0.02 });
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
    // The same turn, under the same name — a fresh one would strand whatever the bridge is
    // already holding, and the hub would then refuse the answer to it.
    expect(turns[0]).toMatchObject({ dispatch: heldDispatch(store, conversation.id, mira.id) });
    expect(turns[1]).toMatchObject({ dispatch: heldDispatch(store, conversation.id, mira.id) });
  });
});

describe("a turn nobody was given", () => {
  it("refuses an answer that names no dispatch the hub handed out", () => {
    const { store, mira, conversation, frames, orchestrator } = setup();
    // No nudge, so no turn. A bridge speaking here is speaking of its own accord — every
    // line validly signed, and every line waking somebody else's paid agent.
    const refused = answer(store, orchestrator, conversation.id, mira.id, {
      dispatch: "a-turn-nobody-gave",
    });

    expect(refused.ok).toBe(false);
    expect(store.transcript(conversation.id, 20)).toHaveLength(0);
    expect(frames.filter((frame) => frame.t === "turn")).toHaveLength(0);
  });

  it("refuses a second answer to the same dispatch", () => {
    const { store, mira, otto, conversation, orchestrator } = setup();
    orchestrator.onNudge(conversation.id, mira.id, "go");
    const dispatch = heldDispatch(store, conversation.id, mira.id);

    expect(answer(store, orchestrator, conversation.id, mira.id, { dispatch }).ok).toBe(true);
    const budgetAfterFirst = store.budget(conversation.id);

    // What a captured frame replayed off the wire looks like from here: the turn is spent, so
    // it buys neither another message nor another round of paid turns for @otto.
    const replayed = answer(store, orchestrator, conversation.id, mira.id, { dispatch });
    expect(replayed.ok).toBe(false);
    expect(store.transcript(conversation.id, 20)).toHaveLength(1);
    expect(store.budget(conversation.id)).toBe(budgetAfterFirst);
    void otto;
  });

  it("keeps nothing when an answer is rolled back", () => {
    const { store, mira, conversation, orchestrator } = setup();
    orchestrator.onNudge(conversation.id, mira.id, "go");
    const dispatch = heldDispatch(store, conversation.id, mira.id);
    answer(store, orchestrator, conversation.id, mira.id, { dispatch, text: "the first" });
    const spendAfterFirst = store.spend(conversation.id).usd;

    answer(store, orchestrator, conversation.id, mira.id, {
      dispatch,
      text: "the replay",
      costUSD: 5,
    });

    // The refused answer must leave nothing behind: not the message, not the charge.
    expect(store.transcript(conversation.id, 20).map((message) => message.text)).toEqual(["the first"]);
    expect(store.spend(conversation.id).usd).toBeCloseTo(spendAfterFirst);
  });

  it("refuses a turn result for somebody else's dispatch", () => {
    const { store, mira, otto, conversation, orchestrator } = setup();
    orchestrator.onNudge(conversation.id, mira.id, "go");
    const mirasTurn = heldDispatch(store, conversation.id, mira.id);

    const stolen = answer(store, orchestrator, conversation.id, otto.id, { dispatch: mirasTurn });
    expect(stolen.ok).toBe(false);
    expect(store.transcript(conversation.id, 20)).toHaveLength(0);
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

  it("still accepts the answer to a turn dispatched before the restart", () => {
    const { store, mira, conversation, orchestrator } = setup();
    orchestrator.onNudge(conversation.id, mira.id, "start on this");
    const dispatch = heldDispatch(store, conversation.id, mira.id);

    const revived = restart(store);
    revived.orchestrator.recover();

    // The dispatch ledger is on disk for exactly this: the bridge is holding a turn it was
    // charged for, and a restart must not turn its answer into a refusal.
    expect(answer(store, revived.orchestrator, conversation.id, mira.id, { dispatch }).ok).toBe(true);
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
    answer(store, orchestrator, conversation.id, mira.id);

    const revived = restart(store);
    revived.orchestrator.recover();

    expect(revived.orchestrator.hasTurn(conversation.id, mira.id)).toBe(false);
    revived.orchestrator.replayTurns(mira.id);
    expect(revived.frames.filter((frame) => frame.t === "turn")).toHaveLength(0);
  });

  it("carries a room's state across, so a goodbye stays a goodbye", () => {
    const { store, mira, otto, conversation, orchestrator } = setup();
    orchestrator.onNudge(conversation.id, mira.id, "wrap this up");
    answer(store, orchestrator, conversation.id, mira.id, {
      text: "settled, then. bye",
      closing: true,
    });
    // One goodbye takes @mira out; the room is still @otto's to speak in.
    expect(store.bowedOut(conversation.id)).toEqual([mira.id]);
    expect(store.roomState(conversation.id)).toBe("live");

    orchestrator.onNudge(conversation.id, otto.id, "anything to add?");
    answer(store, orchestrator, conversation.id, otto.id, { text: "nope, bye", closing: true });
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

    orchestrator.onNudge(conversation.id, mira.id, "go");
    frames.length = 0;
    const before = store.budget(conversation.id);
    answer(store, orchestrator, conversation.id, mira.id, {
      text: "free will is compatible with determinism",
    });

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
    orchestrator.onNudge(conversation.id, mira.id, "go");
    answer(store, orchestrator, conversation.id, mira.id, { text: "a claim" });

    online.add(otto.id);
    frames.length = 0;
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
    orchestrator.onNudge(conversation.id, mira.id, "wrap up");
    answer(store, orchestrator, conversation.id, mira.id, {
      text: "settled, then. bye",
      closing: true,
    });
    orchestrator.onNudge(conversation.id, otto.id, "you too?");
    answer(store, orchestrator, conversation.id, otto.id, { text: "bye", closing: true });

    online.delete(otto.id);
    frames.length = 0;
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
    orchestrator.onNudge(conversation.id, mira.id, "go");
    frames.length = 0;
    const before = store.budget(conversation.id);

    answer(store, orchestrator, conversation.id, mira.id, {
      text: "free will is compatible with determinism",
    });

    expect(dispatchedTo(frames)).toBe(2);
    expect(store.budget(conversation.id)).toBe(before - 2);
  });

  it("asks the newcomer for a turn, since they have heard none of it", () => {
    const { store, mira, conversation, frames, orchestrator, nia } = trio();
    orchestrator.onNudge(conversation.id, mira.id, "go");
    answer(store, orchestrator, conversation.id, mira.id, { text: "a claim" });
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

    orchestrator.onNudge(conversation.id, mira.id, "go");
    frames.length = 0;
    answer(store, orchestrator, conversation.id, mira.id, { text: "still here?" });

    expect(dispatchedTo(frames)).toBe(1);
  });
});

describe("a room erased outright", () => {
  it("forgets a turn it was waiting on, without touching the store", () => {
    const { store, mira, otto, conversation, orchestrator } = setup();
    orchestrator.onNudge(conversation.id, mira.id, "go");
    expect(orchestrator.hasTurn(conversation.id, mira.id)).toBe(true);

    orchestrator.discard(conversation.id, [mira.id, otto.id]);

    expect(orchestrator.hasTurn(conversation.id, mira.id)).toBe(false);
    // Discarding is in-memory bookkeeping only — the caller deletes the room's own rows.
    expect(store.conversation(conversation.id)).toBeDefined();
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
    const { store, mira, conversation, orchestrator } = setup();
    orchestrator.onNudge(conversation.id, mira.id, "go");
    const dispatch = heldDispatch(store, conversation.id, mira.id);

    // Let the deadline actually fire, the way it does when a bridge goes quiet.
    const revived = restart(store);
    revived.orchestrator.recover(Date.now() + 60 * 60_000);
    await Bun.sleep(5);
    expect(revived.orchestrator.hasTurn(conversation.id, mira.id)).toBe(false);

    // Then the daemon finishes anyway. The words crossed, so they belong in the room, and
    // @otto is still owed a reply to them. The dispatch outlives its deadline for precisely
    // this: the turn was charged for, so it stays answerable.
    const late = answer(store, revived.orchestrator, conversation.id, mira.id, {
      dispatch,
      text: "sorry, that took a while",
    });
    expect(late.ok).toBe(true);

    const delivered = revived.frames.some(
      (frame) => frame.t === "appended" && frame.message.text === "sorry, that took a while",
    );
    expect(delivered).toBe(true);
    // And it wakes @otto, because a late answer is still an answer he has not heard.
    expect(revived.frames.some((frame) => frame.t === "turn")).toBe(true);
  });
});
