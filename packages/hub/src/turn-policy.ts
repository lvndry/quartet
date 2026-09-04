/**
 * @fileoverview Who speaks next, as a pure function.
 *
 * The orchestrator applies what this decides and owns the database; this owns the reasoning,
 * so "why did it do that" is one file you can read top to bottom and test in milliseconds.
 * The model it implements is `docs/design/turns.md` and `docs/design/spending.md`.
 *
 * Ten invariants, each broken at least once by hand:
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
 * 9. An agent's goodbye ends its own participation. Only everybody's ends the room.
 * 10. Every dispatch is named, and the name is minted here — so nothing the hub accepts back
 *     can be a turn that was never given out.
 */

import { randomUUID } from "node:crypto";
import { DEFAULT_TURN_BUDGET, type Limit, type RoomState } from "@quartet/protocol";

export type AgentId = string;

export interface InFlight {
  /**
   * The hub's name for this turn.
   *
   * Stored rather than re-derived, because a reconnect replays the *same* turn: a bridge that
   * came back to a different name would be holding a dispatch the hub no longer recognised.
   */
  readonly dispatch: string;
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
   * Which message came last is a database question, so it is handed in rather than worked out
   * here — see `HubStore.owesTurn` for what counts as having answered.
   */
  readonly unanswered: Readonly<Record<AgentId, boolean>>;
  /** Who has said goodbye. One agent's own decision about itself — `docs/design/rooms.md`. */
  readonly bowedOut: readonly AgentId[];
  readonly inFlight: Readonly<Record<AgentId, InFlight>>;
}

export type TurnOutcome = "spoke" | "passed" | "closed" | "failed";

export type TurnEvent =
  | { readonly kind: "message"; readonly author: AgentId }
  /**
   * Wake an agent, with or without something to tell it.
   *
   * `text` absent is a bare poke — the hub starting a new room, where the purpose is the
   * whole of the instruction and travels on its own field. Only an owner's own bridge
   * produces the other kind, and by the time it reaches here it is sealed and unreadable.
   */
  | { readonly kind: "steer"; readonly agent: AgentId; readonly text?: string }
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
      /** The name this turn answers to. Sent to the agent and demanded back. */
      readonly dispatch: string;
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
      // The turn count binds every cost room, not just an unpriced one. Reported spend comes
      // from the participants' own bridges and the hub cannot check it, so a money ceiling is
      // a second bound on top of a turn count, never a replacement for one — see
      // `docs/design/spending.md`.
      return state.turnsLeft > 0 && (state.spendIncomplete || state.spentUSD < state.limit.usd);
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
 * Where a dispatch's name comes from.
 *
 * Injected rather than called directly so this file stays a pure function of its inputs and
 * a test can hand it a counter. The default is the only thing production uses.
 */
export type MintDispatch = () => string;

const mintDispatch: MintDispatch = () => randomUUID().replaceAll("-", "");

/**
 * Consider dispatching a turn to one agent.
 *
 * Every early return is a reason not to spend money, which is why they are in one place.
 */
function poke(state: TurnState, agent: AgentId, mint: MintDispatch, steer?: string): Decision {
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
  // Gone unless its own owner asks. Without this a bow-out means nothing — the next thing the
  // peer said would wake it back up, at full price.
  if (steer === undefined && state.bowedOut.includes(agent)) return { state, effects: [] };
  if (!canSpend(state)) return { state, effects: [] };

  const dispatch = mint();
  const charged: TurnState = {
    ...state,
    turnsLeft: Math.max(0, state.turnsLeft - 1),
    inFlight: {
      ...state.inFlight,
      [agent]: {
        dispatch,
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
        dispatch,
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
      // The turn count binds here too, so warn about whichever ceiling is nearer: an agent
      // told it had money left and then cut off was told the truth about the wrong limit.
      if (state.turnsLeft === 0) return "This is the last turn before the room goes quiet.";
      if (state.spendIncomplete) return undefined;
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
 * Sequential because each dispatch spends from one shared allowance and `canSpend` has to see
 * what the previous took — so a room with one turn left wakes exactly one member, the
 * earliest to join. `docs/design/turns.md` covers why that is deliberate.
 *
 * The announce is collapsed to one: every dispatch changes the same budget.
 */
function pokeAll(
  state: TurnState,
  agents: readonly AgentId[],
  mint: MintDispatch,
  steer?: string,
): Decision {
  let current = state;
  const dispatches: TurnEffect[] = [];
  for (const agent of agents) {
    const decision = poke(current, agent, mint, steer);
    current = decision.state;
    dispatches.push(...decision.effects.filter((effect) => effect.kind !== "announce"));
  }
  const announced = current.turnsLeft !== state.turnsLeft || dispatches.length > 0;
  return { state: current, effects: announced ? [...dispatches, { kind: "announce" }] : [] };
}

/** Apply one event, returning the next state and whatever must happen outside. */
export function decide(
  state: TurnState,
  event: TurnEvent,
  mint: MintDispatch = mintDispatch,
): Decision {
  switch (event.kind) {
    case "message": {
      // Everyone but the speaker. A pass wakes nobody, so a room of six converges rather than
      // spiralling — at the cost of N-1 model runs per message. See `docs/design/turns.md`.
      return pokeAll(state, othersThan(state, event.author), mint);
    }

    case "steer": {
      // A goodbye is not undone by typing at it. Reopening is its own deliberate event, so
      // the app offers Reopen instead of a composer.
      if (state.roomState === "closed") return { state, effects: [] };

      // Speaking to your own agent tops up a spent allowance and takes its goodbye back. It
      // is the only thing that does either — nothing the other party says can.
      const lifted: TurnState = {
        ...state,
        roomState: "live",
        bowedOut: state.bowedOut.filter((agent) => agent !== event.agent),
      };
      const refilled =
        lifted.limit.kind === "turns" && lifted.turnsLeft <= 0
          ? { ...lifted, turnsLeft: lifted.limit.turns }
          : lifted;
      return poke(refilled, event.agent, mint, event.text);
    }

    case "settled": {
      // A goodbye is a fact about the conversation, not about the turn that carried it, so it
      // lands even when that turn was already given up on. Dropping it left the room live
      // with a farewell as its newest message — the one thing nobody should have to answer.
      if (event.outcome === "closed") {
        const bowedOut = state.bowedOut.includes(event.agent)
          ? state.bowedOut
          : [...state.bowedOut, event.agent];
        // Over only when nobody is left who might still speak.
        const everybodyGone = state.participants.every((agent) => bowedOut.includes(agent));
        const settled = {
          ...state,
          bowedOut,
          inFlight: without(state.inFlight, event.agent),
        };
        return {
          state: everybodyGone
            ? { ...settled, roomState: "closed", inFlight: withoutPending(settled.inFlight) }
            : settled,
          effects: [{ kind: "announce" }],
        };
      }

      const finished = state.inFlight[event.agent];
      if (finished === undefined) return { state, effects: [] };
      const cleared = { ...state, inFlight: without(state.inFlight, event.agent) };

      // Falling silent on a turn your owner asked for, then speaking anyway, is being ignored
      // twice. A newer instruction is the one case worth waking for.
      const silenced =
        event.outcome === "passed" && finished.steered && finished.queuedSteer === undefined;
      if (silenced || !finished.pending) return { state: cleared, effects: [] };

      return poke(cleared, event.agent, mint, finished.queuedSteer);
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
      // A halt does not overwrite a goodbye: both mean quiet, and "finished" is the stronger
      // claim of the two.
      const roomState: RoomState = state.roomState === "closed" ? "closed" : "halted";
      return {
        state: { ...state, roomState, inFlight: withoutPending(state.inFlight) },
        effects: [{ kind: "announce" }],
      };
    }

    case "reopen": {
      // Lifts a close and a halt with it. The allowance is left alone — a reopened room with
      // nothing to spend stays quiet until a steer tops it up.
      return { state: { ...state, roomState: "live" }, effects: [{ kind: "announce" }] };
    }

    case "limit": {
      // Exactly what was chosen, up or down: lowering takes effect now rather than after the
      // old allowance drains. A cost limit still carries a turn count, which is the ceiling
      // the hub can actually enforce.
      const turnsLeft =
        event.limit.kind === "turns"
          ? event.limit.turns
          : event.limit.kind === "cost"
            ? Math.max(state.turnsLeft, DEFAULT_TURN_BUDGET)
            : state.turnsLeft;
      // Means "carry on", so it lifts a halt — and not a close, which is the whole reason
      // those are two states rather than one boolean.
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
      // A room needs two people. The last one out closes it rather than leaving an agent
      // talking into an empty room on its owner's money.
      const cleared = {
        ...state,
        // Somebody who has left is not somebody the room is waiting on.
        bowedOut: state.bowedOut.filter((agent) => agent !== event.agent),
        inFlight: without(state.inFlight, event.agent),
      };
      const remaining = cleared.participants;
      const roomState: RoomState =
        remaining.length < 2 || remaining.every((agent) => cleared.bowedOut.includes(agent))
          ? "closed"
          : cleared.roomState;
      return { state: { ...cleared, roomState }, effects: [{ kind: "announce" }] };
    }

    case "arrived": {
      // Nothing dispatches to a socket that is not there, so a message that landed while this
      // agent was away never became a turn. Coming back is when it gets asked — under all the
      // same spending rules.
      if (state.inFlight[event.agent] !== undefined) return { state, effects: [] };
      if (state.unanswered[event.agent] !== true) return { state, effects: [] };
      return poke(state, event.agent, mint);
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
