/**
 * @fileoverview Who speaks next, as a pure function.
 *
 * Every rule about dispatching a turn lives here. The orchestrator applies what this decides
 * and owns the database; this owns the reasoning, so the answer to "why did it do that" is
 * one file you can read top to bottom and one you can test in milliseconds.
 *
 * Six invariants, each of which has been broken at least once by hand:
 *
 * 1. A steer reaches its agent. Messages coalesce because the transcript still holds them;
 *    an instruction exists nowhere else.
 * 2. An agent never speaks immediately after its own pass, unless newly steered.
 * 3. `stopped` holds until a person lifts it.
 * 4. A turn is charged once, at dispatch, and only when one is dispatched.
 * 5. One turn in flight per agent.
 * 6. A closed conversation dispatches nothing.
 */

import { DEFAULT_TURN_BUDGET, type Limit } from "@quartet/protocol";

export type AgentId = string;

export interface InFlight {
  /** Work arrived while this turn was running and is owed one follow-up. */
  readonly pending: boolean;
  /** This turn was asked for by its owner. */
  readonly steered: boolean;
  /** An instruction that arrived mid-turn, carried to the follow-up. Latest wins. */
  readonly queuedSteer?: string;
}

export interface TurnState {
  readonly participants: readonly AgentId[];
  readonly online: Readonly<Record<AgentId, boolean>>;
  readonly limit: Limit;
  /** Counts down on every dispatch. Read only by the rules that care. */
  readonly turnsLeft: number;
  readonly spentUSD: number;
  /** Some spend was unpriced, so `spentUSD` is a floor. */
  readonly spendIncomplete: boolean;
  readonly stopped: boolean;
  readonly inFlight: Readonly<Record<AgentId, InFlight>>;
}

export type TurnOutcome = "spoke" | "passed" | "closed" | "failed";

export type TurnEvent =
  | { readonly kind: "message"; readonly author: AgentId }
  | { readonly kind: "steer"; readonly agent: AgentId; readonly text: string }
  | { readonly kind: "settled"; readonly agent: AgentId; readonly outcome: TurnOutcome }
  | { readonly kind: "spend"; readonly usd: number; readonly incomplete: boolean }
  | { readonly kind: "stop" }
  | { readonly kind: "limit"; readonly limit: Limit }
  | { readonly kind: "offline"; readonly agent: AgentId }
  | { readonly kind: "deadline"; readonly agent: AgentId };

export type TurnEffect =
  | { readonly kind: "dispatch"; readonly agent: AgentId; readonly steer?: string }
  | { readonly kind: "announce" }
  | { readonly kind: "note"; readonly agent: AgentId; readonly text: string };

export interface Decision {
  readonly state: TurnState;
  readonly effects: readonly TurnEffect[];
}

/** Whether this conversation may pay for another turn. */
export function canSpend(state: TurnState): boolean {
  if (state.stopped) return false;
  switch (state.limit.kind) {
    case "turns":
      return state.turnsLeft > 0;
    case "cost":
      // An unpriced run leaves `spentUSD` a floor that never rises, so a money ceiling can
      // never be reached. Such a conversation falls back to the turn count to end somewhere.
      return state.spendIncomplete ? state.turnsLeft > 0 : state.spentUSD < state.limit.usd;
    case "none":
      return true;
    default:
      return false;
  }
}

function without(inFlight: TurnState["inFlight"], agent: AgentId): TurnState["inFlight"] {
  const { [agent]: _removed, ...rest } = inFlight;
  return rest;
}

/** Clear every queued follow-up without touching what is currently running. */
function withoutPending(inFlight: TurnState["inFlight"]): TurnState["inFlight"] {
  return Object.fromEntries(
    Object.entries(inFlight).map(([agent, entry]) => [agent, { ...entry, pending: false }]),
  );
}

/**
 * Consider dispatching a turn to one agent.
 *
 * Every early return is a reason not to spend money, which is why they are all in one place.
 */
function poke(state: TurnState, agent: AgentId, steer?: string): Decision {
  const running = state.inFlight[agent];
  if (running !== undefined) {
    return {
      state: {
        ...state,
        inFlight: {
          ...state.inFlight,
          [agent]: {
            ...running,
            pending: true,
            ...(steer !== undefined ? { queuedSteer: steer } : {}),
          },
        },
      },
      effects: [],
    };
  }

  if (state.online[agent] !== true) return { state, effects: [] };
  if (!canSpend(state)) return { state, effects: [] };

  return {
    state: {
      ...state,
      turnsLeft: Math.max(0, state.turnsLeft - 1),
      inFlight: {
        ...state.inFlight,
        [agent]: { pending: false, steered: steer !== undefined },
      },
    },
    effects: [
      { kind: "dispatch", agent, ...(steer !== undefined ? { steer } : {}) },
      { kind: "announce" },
    ],
  };
}

function otherThan(state: TurnState, agent: AgentId): AgentId | undefined {
  return state.participants.find((candidate) => candidate !== agent);
}

/** Apply one event, returning the next state and whatever must happen outside. */
export function decide(state: TurnState, event: TurnEvent): Decision {
  switch (event.kind) {
    case "message": {
      const other = otherThan(state, event.author);
      return other === undefined ? { state, effects: [] } : poke(state, other);
    }

    case "steer": {
      // Topping the allowance up restarts a room that has gone quiet. A room still running
      // gets the instruction and nothing else: somebody typing into a live argument is as
      // likely to be reining it in as egging it on.
      const lifted = { ...state, stopped: false };
      const refilled =
        lifted.limit.kind === "turns" && lifted.turnsLeft <= 0
          ? { ...lifted, turnsLeft: lifted.limit.turns }
          : lifted;
      return poke(refilled, event.agent, event.text);
    }

    case "settled": {
      const finished = state.inFlight[event.agent];
      if (finished === undefined) return { state, effects: [] };
      const cleared = { ...state, inFlight: without(state.inFlight, event.agent) };

      if (event.outcome === "closed") {
        return {
          state: { ...cleared, stopped: true, inFlight: withoutPending(cleared.inFlight) },
          effects: [{ kind: "announce" }],
        };
      }

      // Passing on a turn its owner asked for stays quiet. Falling silent and then speaking
      // anyway is being ignored twice; a newer instruction is the one case worth waking for.
      const silenced =
        event.outcome === "passed" && finished.steered && finished.queuedSteer === undefined;
      if (silenced || !finished.pending) return { state: cleared, effects: [] };

      return poke(cleared, event.agent, finished.queuedSteer);
    }

    case "spend": {
      return {
        state: {
          ...state,
          spentUSD: state.spentUSD + event.usd,
          spendIncomplete: state.spendIncomplete || event.incomplete,
        },
        effects: [{ kind: "announce" }],
      };
    }

    case "stop": {
      return {
        state: { ...state, stopped: true, inFlight: withoutPending(state.inFlight) },
        effects: [{ kind: "announce" }],
      };
    }

    case "limit": {
      // Raising a ceiling tops the remaining turns up to match, so a conversation that has
      // just gone quiet is usable again at once. A money ceiling keeps a turn count as the
      // fallback for when spend turns out to be unpriced.
      const turnsLeft =
        event.limit.kind === "turns"
          ? Math.max(state.turnsLeft, event.limit.turns)
          : event.limit.kind === "cost"
            ? Math.max(state.turnsLeft, DEFAULT_TURN_BUDGET)
            : state.turnsLeft;
      return {
        state: { ...state, limit: event.limit, turnsLeft, stopped: false },
        effects: [{ kind: "announce" }],
      };
    }

    case "offline": {
      return { state: { ...state, inFlight: without(state.inFlight, event.agent) }, effects: [] };
    }

    case "deadline": {
      if (state.inFlight[event.agent] === undefined) return { state, effects: [] };
      return {
        state: { ...state, inFlight: without(state.inFlight, event.agent) },
        effects: [{ kind: "note", agent: event.agent, text: "no answer in time" }],
      };
    }

    default:
      return { state, effects: [] };
  }
}
