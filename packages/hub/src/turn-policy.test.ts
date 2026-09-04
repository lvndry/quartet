import { describe, expect, it } from "bun:test";
import { canSpend, decide, type TurnEffect, type TurnEvent, type TurnState } from "./turn-policy";

const MIRA = "agt_mira";
const OTTO = "agt_otto";

function room(overrides: Partial<TurnState> = {}): TurnState {
  return {
    participants: [MIRA, OTTO],
    online: { [MIRA]: true, [OTTO]: true },
    limit: { kind: "turns", turns: 6 },
    turnsLeft: 6,
    spentUSD: 0,
    spendIncomplete: false,
    roomState: "live",
    unanswered: { [MIRA]: false, [OTTO]: false },
    bowedOut: [],
    inFlight: {},
    ...overrides,
  };
}

/** Run a sequence, returning the final state and everything that was dispatched. */
function run(start: TurnState, events: readonly TurnEvent[]) {
  let state = start;
  const effects: TurnEffect[] = [];
  for (const event of events) {
    const decision = decide(state, event);
    state = decision.state;
    effects.push(...decision.effects);
  }
  const dispatches = effects.filter(
    (effect): effect is Extract<TurnEffect, { kind: "dispatch" }> => effect.kind === "dispatch",
  );
  return { state, effects, dispatches };
}

describe("who speaks next", () => {
  it("wakes the other agent when one speaks, never the author", () => {
    const { dispatches } = run(room(), [{ kind: "message", author: MIRA }]);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.agent).toBe(OTTO);
  });

  it("charges one turn per dispatch and nothing per event", () => {
    const { state, dispatches } = run(room(), [
      { kind: "message", author: MIRA },
      { kind: "message", author: MIRA },
      { kind: "message", author: MIRA },
    ]);

    // The second and third collapse into the running turn rather than dispatching again.
    expect(dispatches).toHaveLength(1);
    expect(state.turnsLeft).toBe(5);
  });

  it("keeps one turn in flight per agent", () => {
    const { state } = run(room(), [
      { kind: "message", author: MIRA },
      { kind: "message", author: MIRA },
    ]);

    expect(Object.keys(state.inFlight)).toEqual([OTTO]);
    expect(state.inFlight[OTTO]?.pending).toBe(true);
  });

  it("stops dispatching when the turn allowance runs out", () => {
    const { dispatches } = run(room({ turnsLeft: 1 }), [
      { kind: "message", author: MIRA },
      { kind: "settled", agent: OTTO, outcome: "spoke" },
      { kind: "message", author: OTTO },
    ]);

    expect(dispatches).toHaveLength(1);
  });

  it("does not dispatch to an agent whose bridge is gone", () => {
    const { dispatches } = run(room({ online: { [MIRA]: true, [OTTO]: false } }), [
      { kind: "message", author: MIRA },
    ]);

    expect(dispatches).toHaveLength(0);
  });
});

describe("an owner's instruction", () => {
  it("reaches its agent even when one is already thinking", () => {
    // The bug: coalescing collapsed the steer along with the messages, so a live
    // conversation ignored "stop" — the follow-up turn ran with nothing attached.
    const { dispatches } = run(room(), [
      { kind: "message", author: OTTO },
      { kind: "steer", agent: MIRA, text: "wind this up" },
      { kind: "settled", agent: MIRA, outcome: "spoke" },
    ]);

    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]?.steer).toBe("wind this up");
  });

  it("keeps the latest when two arrive during one turn", () => {
    const { dispatches } = run(room(), [
      { kind: "message", author: OTTO },
      { kind: "steer", agent: MIRA, text: "first" },
      { kind: "steer", agent: MIRA, text: "second" },
      { kind: "settled", agent: MIRA, outcome: "spoke" },
    ]);

    expect(dispatches[1]?.steer).toBe("second");
  });

  it("tops the allowance up only when the room has gone quiet", () => {
    // Refilling a running conversation meant typing "stop" bought it more turns.
    const running = run(room({ turnsLeft: 3 }), [{ kind: "steer", agent: MIRA, text: "hi" }]);
    expect(running.state.turnsLeft).toBe(2);

    const quiet = run(room({ turnsLeft: 0 }), [{ kind: "steer", agent: MIRA, text: "hi" }]);
    expect(quiet.state.turnsLeft).toBe(5);
  });

  it("lifts a stop, because typing is how a person restarts a room", () => {
    const { state, dispatches } = run(room({ roomState: "halted" }), [
      { kind: "steer", agent: MIRA, text: "carry on" },
    ]);

    expect(state.roomState).toBe("live");
    expect(dispatches).toHaveLength(1);
  });
});

describe("how a turn ends", () => {
  it("runs the queued follow-up after a plain turn", () => {
    const { dispatches } = run(room(), [
      { kind: "message", author: MIRA },
      { kind: "message", author: MIRA },
      { kind: "settled", agent: OTTO, outcome: "spoke" },
    ]);

    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]?.agent).toBe(OTTO);
  });

  it("stays quiet when a steered turn passes", () => {
    // The bug: the agent fell silent on "stop" and then spoke again in the same breath,
    // because a queued follow-up outlived the pass.
    const { dispatches } = run(room(), [
      { kind: "steer", agent: MIRA, text: "that is enough" },
      { kind: "message", author: OTTO },
      { kind: "settled", agent: MIRA, outcome: "passed" },
    ]);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.steer).toBe("that is enough");
  });

  it("speaks again if the owner asked for something else mid-pass", () => {
    const { dispatches } = run(room(), [
      { kind: "steer", agent: MIRA, text: "wait" },
      { kind: "steer", agent: MIRA, text: "actually, keep going" },
      { kind: "settled", agent: MIRA, outcome: "passed" },
    ]);

    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]?.steer).toBe("actually, keep going");
  });

  it("does not wake the other agent when one passes unprompted", () => {
    const { dispatches } = run(room(), [
      { kind: "message", author: MIRA },
      { kind: "settled", agent: OTTO, outcome: "passed" },
    ]);

    expect(dispatches).toHaveLength(1);
  });

  it("takes one agent out of the conversation when it signs off, and no more", () => {
    const { state, dispatches } = run(room(), [
      { kind: "message", author: OTTO },
      { kind: "message", author: OTTO },
      { kind: "settled", agent: MIRA, outcome: "closed" },
    ]);

    // @otto has not said goodbye and may still have something to say, so the room is his
    // to carry on in. A goodbye is one agent's decision about itself.
    expect(state.bowedOut).toEqual([MIRA]);
    expect(state.roomState).toBe("live");
    expect(dispatches).toHaveLength(1);
  });

  it("closes the conversation once everybody has signed off", () => {
    const { state } = run(room(), [
      { kind: "message", author: OTTO },
      { kind: "settled", agent: MIRA, outcome: "closed" },
      { kind: "settled", agent: OTTO, outcome: "closed" },
    ]);

    expect(state.roomState).toBe("closed");
  });

  it("does not wake an agent that has said goodbye, whatever the other one says", () => {
    // Without this a bow-out is decorative: the peer's next message wakes it straight back
    // up and the loop the sentinel exists to stop carries on at full price.
    const { dispatches } = run(room(), [
      { kind: "settled", agent: MIRA, outcome: "closed" },
      { kind: "message", author: OTTO },
      { kind: "message", author: OTTO },
    ]);

    expect(dispatches.filter((dispatch) => dispatch.agent === MIRA)).toHaveLength(0);
  });

  it("takes a goodbye back when its own owner speaks", () => {
    const { state, dispatches } = run(room(), [
      { kind: "settled", agent: MIRA, outcome: "closed" },
      { kind: "steer", agent: MIRA, text: "actually, ask him about Thursday" },
    ]);

    expect(state.bowedOut).toEqual([]);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ agent: MIRA });
  });

  it("reports an agent that never answered", () => {
    const { state, effects } = run(room(), [
      { kind: "message", author: MIRA },
      { kind: "deadline", agent: OTTO },
    ]);

    expect(effects.some((effect) => effect.kind === "note")).toBe(true);
    expect(state.inFlight[OTTO]).toBeUndefined();
  });
});

describe("stopping", () => {
  it("holds until a person acts", () => {
    const { dispatches } = run(room(), [
      { kind: "stop" },
      { kind: "message", author: MIRA },
      { kind: "message", author: OTTO },
    ]);

    expect(dispatches).toHaveLength(0);
  });

  it("grants a lowered allowance at once rather than after the old one drains", () => {
    // Setting 50 then 6 used to leave 45 turns, because only raising was handled.
    const { state } = run(room({ limit: { kind: "turns", turns: 50 }, turnsLeft: 45 }), [
      { kind: "limit", limit: { kind: "turns", turns: 6 } },
    ]);

    expect(state.turnsLeft).toBe(6);
  });

  it("leaves the chosen limit alone", () => {
    // An earlier attempt rewrote the limit to make a stop stick under a cost rule, which
    // quietly destroyed the setting somebody had picked.
    const { state } = run(room({ limit: { kind: "cost", usd: 5 }, turnsLeft: 6 }), [
      { kind: "stop" },
    ]);

    expect(state.limit).toEqual({ kind: "cost", usd: 5 });
  });

  it("drops queued follow-ups so nothing lands after it", () => {
    const { dispatches } = run(room(), [
      { kind: "message", author: MIRA },
      { kind: "message", author: MIRA },
      { kind: "stop" },
      { kind: "settled", agent: OTTO, outcome: "spoke" },
    ]);

    expect(dispatches).toHaveLength(1);
  });
});

describe("warning an agent the room is nearly out", () => {
  it("says nothing while there is room left", () => {
    const { dispatches } = run(room({ turnsLeft: 6 }), [{ kind: "message", author: MIRA }]);

    expect(dispatches[0]?.notice).toBeUndefined();
  });

  it("warns on the second to last turn", () => {
    const { dispatches } = run(room({ turnsLeft: 2 }), [{ kind: "message", author: MIRA }]);

    expect(dispatches[0]?.notice).toContain("One turn left");
  });

  it("says so on the last turn, so the agent can sign off", () => {
    const { dispatches } = run(room({ turnsLeft: 1 }), [{ kind: "message", author: MIRA }]);

    expect(dispatches[0]?.notice).toContain("last turn");
  });

  it("warns near a spending ceiling", () => {
    const near = room({ limit: { kind: "cost", usd: 1 }, spentUSD: 0.85, turnsLeft: 50 });
    const { dispatches } = run(near, [{ kind: "message", author: MIRA }]);

    expect(dispatches[0]?.notice).toContain("spending limit");
  });

  it("never warns when there is no ceiling to reach", () => {
    const { dispatches } = run(room({ limit: { kind: "none" }, turnsLeft: 0 }), [
      { kind: "message", author: MIRA },
    ]);

    expect(dispatches[0]?.notice).toBeUndefined();
  });
});

describe("spending rules", () => {
  it("counts money under a cost limit, and the turn count as well", () => {
    const state = room({ limit: { kind: "cost", usd: 0.1 }, turnsLeft: 4, spentUSD: 0.05 });
    expect(canSpend(state)).toBe(true);
    expect(canSpend({ ...state, spentUSD: 0.1 })).toBe(false);
  });

  it("stops a cost room that has run out of turns, whatever it says it has spent", () => {
    // The spend figure is the sum of what each participant's own bridge reported, and the
    // hub cannot check one of them. A bridge reporting \$0 for every turn — through a bug or
    // on purpose — would otherwise never reach a money ceiling, and a \"twenty cents\" room
    // would run without bound on everybody else's keys. So the turn count binds too.
    const lying = room({ limit: { kind: "cost", usd: 0.1 }, turnsLeft: 0, spentUSD: 0 });
    expect(canSpend(lying)).toBe(false);
    expect(canSpend({ ...lying, turnsLeft: 1 })).toBe(true);
  });

  it("falls back to the turn count when spend is unpriced", () => {
    // A floor that never rises would leave a money ceiling unreachable forever.
    const unpriced = room({
      limit: { kind: "cost", usd: 5 },
      spendIncomplete: true,
      spentUSD: 0,
      turnsLeft: 0,
    });

    expect(canSpend(unpriced)).toBe(false);
    expect(canSpend({ ...unpriced, turnsLeft: 2 })).toBe(true);
  });

  it("never blocks on a count under no limit at all", () => {
    expect(canSpend(room({ limit: { kind: "none" }, turnsLeft: 0 }))).toBe(true);
  });

  it("refuses everything once closed, whatever the limit says", () => {
    expect(canSpend(room({ limit: { kind: "none" }, roomState: "closed" }))).toBe(false);
  });

  it("refuses everything once halted, whatever the limit says", () => {
    expect(canSpend(room({ limit: { kind: "none" }, roomState: "halted" }))).toBe(false);
  });
});

describe("a goodbye, and what it takes to undo one", () => {
  it("survives somebody choosing a new allowance", () => {
    // The bug this replaces: `stopped` was one boolean, and picking a limit cleared it. An
    // agent could sign off and the room would come back because a person nudged a number.
    const { state, dispatches } = run(room({ roomState: "closed" }), [
      { kind: "limit", limit: { kind: "turns", turns: 20 } },
    ]);

    expect(state.roomState).toBe("closed");
    expect(state.limit).toEqual({ kind: "turns", turns: 20 });
    expect(dispatches).toHaveLength(0);
  });

  it("survives being typed at", () => {
    const { state, dispatches } = run(room({ roomState: "closed" }), [
      { kind: "steer", agent: MIRA, text: "no, keep going" },
    ]);

    expect(state.roomState).toBe("closed");
    expect(dispatches).toHaveLength(0);
  });

  it("survives a person pressing stop on top of it", () => {
    const { state } = run(room({ roomState: "closed" }), [{ kind: "stop" }]);

    expect(state.roomState).toBe("closed");
  });

  it("lands even when the turn that carried it had been given up on", () => {
    // A bridge that answers past its deadline still said goodbye, and the room fanned the
    // message out. Dropping the close left a farewell as the newest unanswered message.
    const { state } = run(room(), [
      { kind: "message", author: OTTO },
      { kind: "deadline", agent: MIRA },
      { kind: "settled", agent: MIRA, outcome: "closed" },
    ]);

    expect(state.bowedOut).toEqual([MIRA]);
  });

  it("stops anyone being asked to reply to it after a reconnect", () => {
    const { dispatches } = run(
      room({ unanswered: { [MIRA]: false, [OTTO]: true }, roomState: "closed" }),
      [{ kind: "arrived", agent: OTTO }],
    );

    expect(dispatches).toHaveLength(0);
  });

  it("gives way to a deliberate reopen, and then runs again", () => {
    const { state, dispatches } = run(room({ roomState: "closed" }), [
      { kind: "reopen" },
      { kind: "steer", agent: MIRA, text: "one more thing" },
    ]);

    expect(state.roomState).toBe("live");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ agent: MIRA, steer: "one more thing" });
  });

  it("leaves a reopened room's spent allowance for the next steer to top up", () => {
    const { state, dispatches } = run(room({ roomState: "closed", turnsLeft: 0 }), [
      { kind: "reopen" },
    ]);

    expect(state.roomState).toBe("live");
    expect(state.turnsLeft).toBe(0);
    expect(dispatches).toHaveLength(0);
  });

  it("records a goodbye against a halted room without overruling the person who halted it", () => {
    const { state } = run(room(), [
      { kind: "message", author: OTTO },
      { kind: "stop" },
      { kind: "settled", agent: MIRA, outcome: "closed" },
    ]);

    // The halt is the person's and stands; the goodbye is @mira's and is recorded. Lifting
    // the halt should not then hand @mira a turn it has already declined.
    expect(state.roomState).toBe("halted");
    expect(state.bowedOut).toEqual([MIRA]);
  });

  it("keeps a halt liftable by carrying on", () => {
    const { state, dispatches } = run(room({ roomState: "halted" }), [
      { kind: "limit", limit: { kind: "turns", turns: 4 } },
    ]);

    expect(state.roomState).toBe("live");
    expect(state.turnsLeft).toBe(4);
    expect(dispatches).toHaveLength(0);
  });
});

describe("an agent that was away", () => {
  const owed = (extra: Partial<TurnState> = {}) =>
    room({ unanswered: { [MIRA]: true, [OTTO]: false }, ...extra });

  it("is asked for the turn it missed when it comes back", () => {
    const { dispatches } = run(owed(), [{ kind: "arrived", agent: MIRA }]);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.agent).toBe(MIRA);
  });

  it("is left alone when it has already answered everything", () => {
    const { dispatches } = run(room(), [{ kind: "arrived", agent: MIRA }]);

    expect(dispatches).toHaveLength(0);
  });

  it("does not get a second turn on top of one already in flight", () => {
    // replayTurns re-delivers that one. Poking here would queue a spurious follow-up.
    const { state, dispatches } = run(owed(), [
      { kind: "arrived", agent: MIRA },
      { kind: "arrived", agent: MIRA },
    ]);

    expect(dispatches).toHaveLength(1);
    expect(state.inFlight[MIRA]?.pending).toBe(false);
  });

  it("does not restart a room a person stopped", () => {
    const { state, dispatches } = run(owed({ roomState: "halted" }), [
      { kind: "arrived", agent: MIRA },
    ]);

    expect(dispatches).toHaveLength(0);
    expect(state.roomState).toBe("halted");
  });

  it("does not reopen a room an agent closed", () => {
    const { dispatches } = run(owed({ roomState: "closed" }), [
      { kind: "arrived", agent: MIRA },
    ]);

    expect(dispatches).toHaveLength(0);
  });

  it("does not spend an allowance that is already gone", () => {
    const { dispatches } = run(owed({ turnsLeft: 0 }), [{ kind: "arrived", agent: MIRA }]);

    expect(dispatches).toHaveLength(0);
  });

  it("charges the turn once, like any other dispatch", () => {
    const { state } = run(owed({ turnsLeft: 6 }), [{ kind: "arrived", agent: MIRA }]);

    expect(state.turnsLeft).toBe(5);
  });
});

const NIA = "agt_nia";
const ADA = "agt_ada";

/** A room of four, everybody present, nobody owed anything yet. */
function quartet(overrides: Partial<TurnState> = {}): TurnState {
  const members = [MIRA, OTTO, NIA, ADA];
  return room({
    participants: members,
    online: Object.fromEntries(members.map((agent) => [agent, true])),
    unanswered: Object.fromEntries(members.map((agent) => [agent, false])),
    ...overrides,
  });
}

describe("a room with more than two people in it", () => {
  it("wakes everyone but the speaker", () => {
    const { dispatches } = run(quartet(), [{ kind: "message", author: MIRA }]);

    expect(dispatches.map((dispatch) => dispatch.agent).sort()).toEqual([ADA, NIA, OTTO].sort());
  });

  it("never asks the speaker to answer themselves", () => {
    const { dispatches } = run(quartet(), [{ kind: "message", author: NIA }]);

    expect(dispatches.map((dispatch) => dispatch.agent)).not.toContain(NIA);
  });

  it("charges one turn per agent woken, because that is one model run each", () => {
    const { state } = run(quartet({ turnsLeft: 10 }), [{ kind: "message", author: MIRA }]);

    expect(state.turnsLeft).toBe(7);
  });

  it("says once that the budget moved, not once per dispatch", () => {
    const { effects } = run(quartet(), [{ kind: "message", author: MIRA }]);

    expect(effects.filter((effect) => effect.kind === "announce")).toHaveLength(1);
  });

  it("stops at the allowance rather than overdrawing it", () => {
    const { state, dispatches } = run(quartet({ turnsLeft: 2 }), [
      { kind: "message", author: MIRA },
    ]);

    expect(dispatches).toHaveLength(2);
    expect(state.turnsLeft).toBe(0);
  });

  it("gives the last turn to whoever joined earliest, deterministically", () => {
    const { dispatches } = run(quartet({ turnsLeft: 1 }), [{ kind: "message", author: MIRA }]);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.agent).toBe(OTTO);
  });

  it("skips whoever is offline and wakes the rest", () => {
    const { dispatches } = run(
      quartet({ online: { [MIRA]: true, [OTTO]: false, [NIA]: true, [ADA]: false } }),
      [{ kind: "message", author: MIRA }],
    );

    expect(dispatches.map((dispatch) => dispatch.agent)).toEqual([NIA]);
  });

  it("lets a pass end it, because a pass wakes nobody", () => {
    const { dispatches } = run(quartet(), [
      { kind: "message", author: MIRA },
      { kind: "settled", agent: OTTO, outcome: "passed" },
      { kind: "settled", agent: NIA, outcome: "passed" },
      { kind: "settled", agent: ADA, outcome: "passed" },
    ]);

    // Three woken by the one message, and nothing after: silence is not answered.
    expect(dispatches).toHaveLength(3);
  });

  it("does not close for everybody when one agent signs off", () => {
    // This asserted the opposite, which is how one agent's "I love you too" ended a room
    // in a single exchange — and in a room of four would have ended it for three people
    // who were still talking.
    const { state } = run(quartet(), [
      { kind: "message", author: MIRA },
      { kind: "settled", agent: OTTO, outcome: "closed" },
    ]);

    expect(state.bowedOut).toEqual([OTTO]);
    expect(state.roomState).toBe("live");
  });

  it("closes only once the last of them has signed off", () => {
    const { state } = run(quartet(), [
      { kind: "message", author: MIRA },
      { kind: "settled", agent: OTTO, outcome: "closed" },
      { kind: "settled", agent: ADA, outcome: "closed" },
      { kind: "settled", agent: NIA, outcome: "closed" },
    ]);

    // Three of four gone is still a room @mira could speak in.
    expect(state.roomState).toBe("live");

    const { state: empty } = run(state, [{ kind: "settled", agent: MIRA, outcome: "closed" }]);
    expect(empty.roomState).toBe("closed");
  });

  it("steers only your own agent, never the whole room", () => {
    const { dispatches } = run(quartet(), [{ kind: "steer", agent: ADA, text: "push back" }]);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ agent: ADA, steer: "push back" });
  });
});

describe("somebody leaving a room", () => {
  it("gives up any turn that was owed to them", () => {
    const { state } = run(quartet(), [
      { kind: "message", author: MIRA },
      { kind: "left", agent: OTTO },
    ]);

    expect(state.inFlight[OTTO]).toBeUndefined();
    expect(state.inFlight[NIA]).toBeDefined();
  });

  it("leaves the room running while two people are still in it", () => {
    // `participants` has already lost them by the time this is applied.
    const { state } = run(quartet({ participants: [MIRA, NIA, ADA] }), [
      { kind: "left", agent: OTTO },
    ]);

    expect(state.roomState).toBe("live");
  });

  it("closes the room when it would leave one agent talking to itself", () => {
    const { state } = run(quartet({ participants: [MIRA] }), [{ kind: "left", agent: OTTO }]);

    expect(state.roomState).toBe("closed");
  });
});
