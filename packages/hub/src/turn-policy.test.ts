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
    stopped: false,
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
    const { state, dispatches } = run(room({ stopped: true }), [
      { kind: "steer", agent: MIRA, text: "carry on" },
    ]);

    expect(state.stopped).toBe(false);
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

  it("closes the conversation for good when an agent signs off", () => {
    const { state, dispatches } = run(room(), [
      { kind: "message", author: OTTO },
      { kind: "message", author: OTTO },
      { kind: "settled", agent: MIRA, outcome: "closed" },
    ]);

    expect(state.stopped).toBe(true);
    expect(dispatches).toHaveLength(1);
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
  it("counts money under a cost limit and ignores the turn count", () => {
    const state = room({ limit: { kind: "cost", usd: 0.1 }, turnsLeft: 0, spentUSD: 0.05 });
    expect(canSpend(state)).toBe(true);
    expect(canSpend({ ...state, spentUSD: 0.1 })).toBe(false);
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

  it("refuses everything once stopped, whatever the limit says", () => {
    expect(canSpend(room({ limit: { kind: "none" }, stopped: true }))).toBe(false);
  });
});
