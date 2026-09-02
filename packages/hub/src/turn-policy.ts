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
 * 3. A halt holds until a person lifts it, and a close holds until a person reopens it.
 * 4. A turn is charged once, at dispatch, and only when one is dispatched.
 * 5. One turn in flight per agent.
 * 6. A closed conversation dispatches nothing.
 * 7. A message that arrived while an agent was away is still answered when it returns.
 * 8. A spoken message reaches every other member, and no member hears their own.
 */

import { DEFAULT_TURN_BUDGET, type Limit, type RoomState } from "@quartet/protocol";

export type AgentId = string;

export interface InFlight {
  /** Work arrived while this turn was running and is owed one follow-up. */
  readonly pending: boolean;
  /** This turn was asked for by its owner. */
  readonly steered: boolean;
  /** An instruction that arrived mid-turn, carried to the follow-up. Latest wins. */
  readonly queuedSteer?: string;
  /** The steer this in-flight turn was dispatched with, so a reconnect can replay it. */
  readonly dispatchSteer?: string;
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
  /** Running, halted by a person, or closed by an agent. Only `live` may spend. */
  readonly roomState: RoomState;
  /**
   * Per agent, whether the room holds something they have not answered.
   *
   * Which message came last is a database question, so it is handed in rather than worked
   * out here — see `HubStore.owesTurn`, which also documents why a pass counts as an answer
   * and a system note is not something to answer.
   */
  readonly unanswered: Readonly<Record<AgentId, boolean>>;
  readonly inFlight: Readonly<Record<AgentId, InFlight>>;
}

export type TurnOutcome = "spoke" | "passed" | "closed" | "failed";

export type TurnEvent =
  | { readonly kind: "message"; readonly author: AgentId }
  | { readonly kind: "steer"; readonly agent: AgentId; readonly text: string }
  | { readonly kind: "settled"; readonly agent: AgentId; readonly outcome: TurnOutcome }
  | { readonly kind: "spend"; readonly usd: number; readonly incomplete: boolean }
  | { readonly kind: "stop" }
  | { readonly kind: "reopen" }
  | { readonly kind: "limit"; readonly limit: Limit }
  | { readonly kind: "offline"; readonly agent: AgentId }
  /** This agent's bridge just connected. */
  | { readonly kind: "arrived"; readonly agent: AgentId }
  /** This agent has left the room. Applied after they are gone from `participants`. */
  | { readonly kind: "left"; readonly agent: AgentId }
  | { readonly kind: "deadline"; readonly agent: AgentId };

export type TurnEffect =
  | {
      readonly kind: "dispatch";
      readonly agent: AgentId;
      readonly steer?: string;
      /** Sent when the allowance is nearly gone, so the agent can close rather than be cut. */
      readonly notice?: string;
    }
  | { readonly kind: "announce" }
  | { readonly kind: "note"; readonly agent: AgentId; readonly text: string };

export interface Decision {
  readonly state: TurnState;
  readonly effects: readonly TurnEffect[];
}

/** Whether this conversation may pay for another turn. */
export function canSpend(state: TurnState): boolean {
  if (state.roomState !== "live") return false;
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

  const charged: TurnState = {
    ...state,
    turnsLeft: Math.max(0, state.turnsLeft - 1),
    inFlight: {
      ...state.inFlight,
      [agent]: {
        pending: false,
        steered: steer !== undefined,
        ...(steer !== undefined ? { dispatchSteer: steer } : {}),
      },
    },
  };
  const notice = noticeFor(charged);

  return {
    state: charged,
    effects: [
      {
        kind: "dispatch",
        agent,
        ...(steer !== undefined ? { steer } : {}),
        ...(notice !== undefined ? { notice } : {}),
      },
      { kind: "announce" },
    ],
  };
}

/** How close this conversation is to its ceiling, in words an agent can act on. */
function noticeFor(state: TurnState): string | undefined {
  switch (state.limit.kind) {
    case "turns":
      if (state.turnsLeft === 0) return "This is the last turn before the room goes quiet.";
      if (state.turnsLeft === 1) return "One turn left after this one.";
      return undefined;
    case "cost": {
      if (state.spendIncomplete) {
        return state.turnsLeft === 0 ? "This is the last turn before the room goes quiet." : undefined;
      }
      const left = state.limit.usd - state.spentUSD;
      if (left <= 0) return "This is the last turn before the room goes quiet.";
      return left / state.limit.usd <= 0.2 ? "Nearly at the spending limit for this room." : undefined;
    }
    case "none":
      return undefined;
    default:
      return undefined;
  }
}

function othersThan(state: TurnState, agent: AgentId): AgentId[] {
  return state.participants.filter((candidate) => candidate !== agent);
}

/**
 * Offer a turn to several agents, in room order.
 *
 * Sequential rather than parallel because each dispatch spends from one shared allowance,
 * and `canSpend` has to see what the previous one took. That has a consequence worth being
 * deliberate about: a room with one turn left and three other members wakes exactly one of
 * them, and it is the one who joined earliest. Arbitrary, but deterministic and cheap to
 * reason about — the alternative is a fairness rule, and the honest place to earn one is
 * after watching real rooms run out of allowance.
 *
 * The announce is collapsed to one. Every dispatch changes the same budget, and telling
 * the room five times that it did is noise.
 */
function pokeAll(state: TurnState, agents: readonly AgentId[], steer?: string): Decision {
  let current = state;
  const dispatches: TurnEffect[] = [];
  for (const agent of agents) {
    const decision = poke(current, agent, steer);
    current = decision.state;
    dispatches.push(...decision.effects.filter((effect) => effect.kind !== "announce"));
  }
  const announced = current.turnsLeft !== state.turnsLeft || dispatches.length > 0;
  return { state: current, effects: announced ? [...dispatches, { kind: "announce" }] : [] };
}

/** Apply one event, returning the next state and whatever must happen outside. */
export function decide(state: TurnState, event: TurnEvent): Decision {
  switch (event.kind) {
    case "message": {
      // Everyone but the speaker. Each of them either answers or passes, and a pass wakes
      // nobody — so a room of six does not spiral, it converges on whoever has something
      // to say. Expensive by construction: one message is N-1 model runs, on N-1 people's
      // own keys, which is what the allowance is for.
      return pokeAll(state, othersThan(state, event.author));
    }

    case "steer": {
      // A goodbye is not undone by typing at it. Reopening is a deliberate act with its own
      // event, so a steer into a closed room is dropped here and the app offers Reopen
      // instead of a composer.
      if (state.roomState === "closed") return { state, effects: [] };

      // Topping the allowance up restarts a room that has gone quiet. A room still running
      // gets the instruction and nothing else: somebody typing into a live argument is as
      // likely to be reining it in as egging it on.
      const lifted: TurnState = { ...state, roomState: "live" };
      const refilled =
        lifted.limit.kind === "turns" && lifted.turnsLeft <= 0
          ? { ...lifted, turnsLeft: lifted.limit.turns }
          : lifted;
      return poke(refilled, event.agent, event.text);
    }

    case "settled": {
      // A goodbye is a fact about the conversation, not about the turn that carried it, so
      // it lands even when that turn has already been given up on. A bridge that answers
      // after its deadline still said goodbye and the message is still delivered; dropping
      // the close here left the room live with a farewell as its newest message, which is
      // the one thing nobody should be asked to reply to.
      if (event.outcome === "closed") {
        const settled = { ...state, inFlight: without(state.inFlight, event.agent) };
        return {
          state: { ...settled, roomState: "closed", inFlight: withoutPending(settled.inFlight) },
          effects: [{ kind: "announce" }],
        };
      }

      const finished = state.inFlight[event.agent];
      if (finished === undefined) return { state, effects: [] };
      const cleared = { ...state, inFlight: without(state.inFlight, event.agent) };

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
      // A person halting a room does not overwrite an agent's goodbye: both mean the room
      // is quiet, and the one that says a conversation is *finished* is the stronger claim.
      const roomState: RoomState = state.roomState === "closed" ? "closed" : "halted";
      return {
        state: { ...state, roomState, inFlight: withoutPending(state.inFlight) },
        effects: [{ kind: "announce" }],
      };
    }

    case "reopen": {
      // Lifts a close, and a halt with it — both mean "carry on". The allowance is left
      // alone: a reopened room with nothing left to spend is quiet until somebody speaks,
      // and that steer is what tops it up.
      return { state: { ...state, roomState: "live" }, effects: [{ kind: "announce" }] };
    }

    case "limit": {
      // Choosing an allowance grants exactly that, up or down: raising it makes a quiet room
      // usable again, and lowering it takes effect now rather than after the old one drains.
      // A money ceiling keeps a turn count as the fallback for when spend is unpriced.
      const turnsLeft =
        event.limit.kind === "turns"
          ? event.limit.turns
          : event.limit.kind === "cost"
            ? Math.max(state.turnsLeft, DEFAULT_TURN_BUDGET)
            : state.turnsLeft;
      // Choosing an allowance means "carry on", so it lifts a halt. It does not lift a
      // close: an agent's goodbye surviving somebody nudging a number is the whole reason
      // these are two states and not one boolean.
      const roomState: RoomState = state.roomState === "halted" ? "live" : state.roomState;
      return {
        state: { ...state, limit: event.limit, turnsLeft, roomState },
        effects: [{ kind: "announce" }],
      };
    }

    case "offline": {
      return { state: { ...state, inFlight: without(state.inFlight, event.agent) }, effects: [] };
    }

    case "left": {
      // A room needs two people to be a conversation. The last one out closes it rather
      // than leaving somebody's agent talking into an empty room on their own money.
      const cleared = { ...state, inFlight: without(state.inFlight, event.agent) };
      const roomState: RoomState =
        cleared.participants.length < 2 ? "closed" : cleared.roomState;
      return { state: { ...cleared, roomState }, effects: [{ kind: "announce" }] };
    }

    case "arrived": {
      // The hub never dispatches to a socket that is not there, so a message that arrived
      // while this agent was away never became a turn and nothing later re-asked. Coming
      // back is when it gets asked. Everything else about spending still applies: a halted
      // or closed room stays quiet, and an exhausted allowance still waits on a person.
      if (state.inFlight[event.agent] !== undefined) return { state, effects: [] };
      if (state.unanswered[event.agent] !== true) return { state, effects: [] };
      return poke(state, event.agent);
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
