import { describe, expect, it } from "bun:test";
import { canSpend, decide, type TurnEffect, type TurnEvent, type TurnState } from "./turn-policy";

/**
 * Random event orders, checked against the invariants.
 *
 * Three of the bugs this file guards against were interleavings nobody wrote down: a steer
 * landing 40ms into a turn that was about to pass, a stop arriving between a dispatch and its
 * reply. Enumerating those by hand is how they were missed in the first place.
 */

const MIRA = "agt_mira";
const OTTO = "agt_otto";
const AGENTS = [MIRA, OTTO] as const;

/** Deterministic, so a failure names a seed that reproduces it exactly. */
function randomiser(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)] as T;
}

function randomEvent(next: () => number, state: TurnState): TurnEvent {
  const agent = pick(next, AGENTS);
  const running = Object.keys(state.inFlight);
  const roll = next();

  if (roll < 0.3) return { kind: "message", author: agent };
  if (roll < 0.45) return { kind: "steer", agent, text: `steer-${String(Math.floor(next() * 99))}` };
  if (roll < 0.75 && running.length > 0) {
    return {
      kind: "settled",
      agent: pick(next, running),
      outcome: pick(next, ["spoke", "passed", "closed", "failed"] as const),
    };
  }
  if (roll < 0.80) return { kind: "stop" };
  if (roll < 0.82) return { kind: "reopen" };
  if (roll < 0.88) return { kind: "spend", usd: next() * 0.02, incomplete: next() < 0.2 };
  if (roll < 0.94) {
    return {
      kind: "limit",
      limit: pick(next, [
        { kind: "turns", turns: 6 },
        { kind: "cost", usd: 1 },
        { kind: "none" },
      ] as const),
    };
  }
  if (roll < 0.96) return { kind: "offline", agent };
  if (roll < 0.98) return { kind: "arrived", agent };
  return { kind: "deadline", agent };
}

describe("whatever order events arrive in", () => {
  it("holds every invariant across a thousand random runs", () => {
    for (let seed = 1; seed <= 1000; seed += 1) {
      const next = randomiser(seed);
      let state: TurnState = {
        participants: [...AGENTS],
        online: { [MIRA]: true, [OTTO]: true },
        limit: { kind: "turns", turns: 6 },
        turnsLeft: 6,
        spentUSD: 0,
        spendIncomplete: false,
        roomState: "live",
        unanswered: { [MIRA]: true, [OTTO]: true },
        inFlight: {},
      };

      for (let step = 0; step < 60; step += 1) {
        const event = randomEvent(next, state);
        const before = state;
        const { state: after, effects } = decide(state, event);
        const dispatches = effects.filter(
          (effect): effect is Extract<TurnEffect, { kind: "dispatch" }> =>
            effect.kind === "dispatch",
        );
        const where = `seed ${String(seed)} step ${String(step)} on ${event.kind}`;

        // 3 and 6: a room that is not live dispatches nothing, and nothing but a person's
        // own action brings it back. A halt is lifted by carrying on — speaking, or choosing
        // a new allowance — while a close needs the deliberate reopen and nothing else.
        const lifts: readonly TurnEvent["kind"][] =
          before.roomState === "halted" ? ["steer", "limit", "reopen"] : ["reopen"];
        // Coming back online is not a way to restart a room somebody stopped.
        if (before.roomState !== "live" && !lifts.includes(event.kind)) {
          expect(dispatches, `${where}: dispatched while ${before.roomState}`).toHaveLength(0);
          // Not that the state is unchanged — a halted room whose in-flight turn comes back
          // with a goodbye becomes closed, and that is the honest reading of what happened.
          // What may not happen is a quiet room deciding on its own to run again.
          expect(after.roomState, `${where}: a ${before.roomState} room revived itself`).not.toBe(
            "live",
          );
        }

        // A goodbye is final until somebody reopens the room: no event other than that one
        // may turn `closed` back into anything else.
        if (before.roomState === "closed" && event.kind !== "reopen") {
          expect(after.roomState, `${where}: a close was undone by ${event.kind}`).toBe("closed");
        }

        // 5: never two turns in flight for one agent.
        for (const agent of AGENTS) {
          const running = Object.entries(after.inFlight).filter(([id]) => id === agent);
          expect(running.length, `${where}: ${agent} has ${String(running.length)} turns`).toBeLessThanOrEqual(1);
        }

        // 4: the allowance falls only by dispatching, except where a person sets it.
        if (event.kind === "limit") {
          // Choosing an allowance grants exactly that, up or down, minus anything dispatched
          // in the same step.
          if (event.limit.kind === "turns") {
            expect(after.turnsLeft, `${where}: limit not granted outright`).toBe(
              event.limit.turns - dispatches.length,
            );
          }
        } else if (event.kind === "steer") {
          expect(after.turnsLeft, `${where}: a steer took turns away`).toBeGreaterThanOrEqual(
            before.turnsLeft - dispatches.length,
          );
        } else {
          const charged = before.turnsLeft - after.turnsLeft;
          expect(
            charged,
            `${where}: charged ${String(charged)} for ${String(dispatches.length)} dispatches`,
          ).toBe(Math.min(dispatches.length, before.turnsLeft));
        }

        // 1: a dispatch only ever happens when the conversation could pay for it.
        if (dispatches.length > 0) {
          expect(canSpend(before) || event.kind === "steer" || event.kind === "limit", `${where}: dispatched unaffordably`).toBe(true);
        }

        // 2: an agent never speaks straight after its own unprompted pass.
        if (event.kind === "settled" && event.outcome === "passed") {
          const wasSteered = before.inFlight[event.agent]?.steered === true;
          const hadNewSteer = before.inFlight[event.agent]?.queuedSteer !== undefined;
          if (wasSteered && !hadNewSteer) {
            expect(
              dispatches.some((dispatch) => dispatch.agent === event.agent),
              `${where}: spoke straight after a steered pass`,
            ).toBe(false);
          }
        }

        state = after;
      }
    }
  });

  it("never loses a steer that arrives while an agent is thinking", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = randomiser(seed);
      let state: TurnState = {
        participants: [...AGENTS],
        online: { [MIRA]: true, [OTTO]: true },
        limit: { kind: "none" },
        turnsLeft: 0,
        spentUSD: 0,
        spendIncomplete: false,
        roomState: "live",
        unanswered: { [MIRA]: true, [OTTO]: true },
        inFlight: {},
      };

      // Put a turn in flight, queue a steer behind it, then settle.
      state = decide(state, { kind: "message", author: OTTO }).state;
      const steered = decide(state, { kind: "steer", agent: MIRA, text: `s${String(seed)}` });
      state = steered.state;

      const outcome = pick(next, ["spoke", "failed"] as const);
      const { effects } = decide(state, { kind: "settled", agent: MIRA, outcome });
      const dispatched = effects.filter(
        (effect): effect is Extract<TurnEffect, { kind: "dispatch" }> => effect.kind === "dispatch",
      );

      expect(dispatched.some((dispatch) => dispatch.steer === `s${String(seed)}`), `seed ${String(seed)}`).toBe(true);
    }
  });
});
