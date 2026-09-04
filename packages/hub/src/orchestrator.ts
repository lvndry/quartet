/**
 * @fileoverview Applying what the turn policy decides.
 *
 * The reasoning is `turn-policy.ts`, as a pure function; this holds the live pieces it cannot
 * touch — the socket registry, the database, the deadline timers.
 *
 * One rule governs the shape of everything below: **every durable change a single event
 * causes is written in one transaction, and nothing is sent until it commits.** Frames go
 * into an outbox, timers are armed after the commit, so a rollback cannot leave anybody
 * having been told about a state that does not exist. `docs/design.md` §4 says what that
 * fixed.
 */

import type { HubStore } from "./db";
import {
  decide,
  type MintDispatch,
  type TurnEffect,
  type TurnEvent,
  type TurnOutcome,
  type TurnState,
} from "./turn-policy";
import {
  TURN_OVERLAP,
  type Limit,
  type Message,
  type MessageKind,
  type ServerFrame,
  type Signature,
} from "@quartet/protocol";

/**
 * How long the hub waits for an answer before saying the room went quiet.
 *
 * Generous, because a local model on a cold load is slow and calling that failure would break
 * the product for exactly the people running it as intended. It bounds the *wait*, not the
 * dispatch: the turn stays answerable — see `HubStore.dispatchState`.
 */
const TURN_DEADLINE_MS = 180_000;

/** A parked tool waits on a person, not on the model. Three minutes is not enough. */
const APPROVAL_DEADLINE_MS = 15 * 60_000;

export type Deliver = (agentId: string, frame: ServerFrame) => void;
export type IsOnline = (agentId: string) => boolean;

/** One frame, waiting for the transaction that justifies it to commit. */
interface Outbound {
  readonly agentId: string;
  readonly frame: ServerFrame;
}

/** What accepting one agent's answer to a turn concluded. */
export type Accepted = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/**
 * Thrown inside the turn transaction to roll the whole thing back.
 *
 * A dispatch that turns out to be already settled between the check and the write is a
 * replay, and half of the answer must not be kept.
 */
class Refused extends Error {}

export class Orchestrator {
  /** In-memory turn bookkeeping per conversation; the database holds the durable half. */
  private readonly turns = new Map<string, TurnState["inFlight"]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: HubStore,
    private readonly deliver: Deliver,
    private readonly isOnline: IsOnline,
    private readonly onRoomChange?: (conversationId: string) => void,
    /** Overridden only by tests that need a dispatch id they can predict. */
    private readonly mint?: MintDispatch,
  ) {}

  private static timerKey(conversationId: string, agentId: string): string {
    return `${conversationId}::${agentId}`;
  }

  /** Assemble what the policy needs from the database and the socket registry. */
  private read(conversationId: string): TurnState | undefined {
    const participants = this.store.conversationParticipantIds(conversationId);
    if (participants === undefined) return undefined;
    const spend = this.store.spend(conversationId);
    return {
      participants,
      online: Object.fromEntries(participants.map((agentId) => [agentId, this.isOnline(agentId)])),
      limit: this.store.limitFor(conversationId),
      turnsLeft: this.store.budget(conversationId),
      spentUSD: spend.usd,
      spendIncomplete: spend.incomplete,
      roomState: this.store.roomState(conversationId),
      unanswered: Object.fromEntries(
        participants.map((agentId) => [agentId, this.store.owesTurn(conversationId, agentId)]),
      ),
      bowedOut: this.store.bowedOut(conversationId),
      inFlight: this.turns.get(conversationId) ?? {},
    };
  }

  /**
   * Persist everything the policy just decided, in-flight turns included.
   *
   * In-flight turns are durable because the charge for them is: a restart mid-turn used to
   * leave a room paid up and permanently silent. `recover` reads these rows back.
   *
   * The in-memory copy is deliberately *not* updated here but after the commit, so a rollback
   * cannot leave memory claiming a turn the database never accepted.
   */
  private persistState(conversationId: string, state: TurnState): void {
    this.store.setBudget(conversationId, state.turnsLeft);
    this.store.setState(conversationId, state.roomState);
    // Written as a diff so an unchanged bow-out does not keep moving its timestamp, which
    // is what the app orders the list by.
    const wasBowedOut = new Set(this.store.bowedOut(conversationId));
    for (const agentId of state.participants) {
      const now = state.bowedOut.includes(agentId);
      if (now !== wasBowedOut.has(agentId)) {
        this.store.setBowedOut(conversationId, agentId, now);
      }
    }
    this.store.setSpend(conversationId, state.spentUSD, state.spendIncomplete);

    const before = this.turns.get(conversationId) ?? {};
    for (const agentId of Object.keys(before)) {
      if (state.inFlight[agentId] === undefined) this.store.clearInFlight(conversationId, agentId);
    }
    for (const [agentId, entry] of Object.entries(state.inFlight)) {
      this.store.saveInFlight(conversationId, agentId, entry);
    }
  }

  /**
   * Write down what one effect changes, and queue what it sends.
   *
   * Runs inside the transaction. Timers and deliveries are handed back rather than performed,
   * because both outlive a rollback and a frame sent is not recallable.
   */
  private persistEffect(
    conversationId: string,
    effect: TurnEffect,
    outbox: Outbound[],
    deadlines: { agentId: string; ms: number }[],
  ): void {
    switch (effect.kind) {
      case "dispatch": {
        const conversation = this.store.conversation(conversationId);
        if (conversation === undefined) return;
        // The ledger entry and the charge land together, so there is no window in which a
        // bridge holds a turn whose answer the hub would refuse.
        this.store.recordDispatch(conversationId, effect.agent, effect.dispatch);
        deadlines.push({ agentId: effect.agent, ms: TURN_DEADLINE_MS });
        // The increment, not a window of the room — see `docs/design.md` §4.
        const slice = this.store.transcriptFor(conversationId, effect.agent, TURN_OVERLAP);
        outbox.push({
          agentId: effect.agent,
          frame: {
            t: "turn",
            conversationId,
            dispatch: effect.dispatch,
            purpose: conversation.purpose,
            transcript: slice.messages,
            earlier: slice.earlier,
            ...(effect.steer !== undefined ? { steer: effect.steer } : {}),
            ...(effect.notice !== undefined ? { notice: effect.notice } : {}),
          },
        });
        return;
      }

      case "announce": {
        for (const outbound of this.budgetFrames(conversationId)) outbox.push(outbound);
        return;
      }

      case "note": {
        const message = this.store.appendMessage({
          conversationId,
          authorAgentId: effect.agent,
          kind: "system",
          text: effect.text,
        });
        if (message !== undefined) this.queueFanOut(conversationId, message, outbox);
        return;
      }

      default:
        return;
    }
  }

  /**
   * Fold a run of events into one durable step.
   *
   * `inside` is whatever has to be written first — the message an event is about, the
   * dispatch that produced it — and it runs in the same transaction, so the message and the
   * turn state it settles are one fact.
   */
  private applyAll(
    conversationId: string,
    events: readonly TurnEvent[],
    inside?: (outbox: Outbound[]) => void,
  ): Accepted {
    const before = this.read(conversationId);
    if (before === undefined) return { ok: false, detail: "no such conversation" };

    const outbox: Outbound[] = [];
    const deadlines: { agentId: string; ms: number }[] = [];
    let settled: TurnState | undefined;

    try {
      this.store.transaction(() => {
        inside?.(outbox);
        let state = before;
        const effects: TurnEffect[] = [];
        for (const event of events) {
          const decision = decide(state, event, this.mint);
          state = decision.state;
          // A limit change is the one event that rewrites the rule itself, so it is persisted
          // through the store's own setter, which keeps the turn ceiling in step with it.
          if (event.kind === "limit") this.store.setLimit(conversationId, state.limit);
          effects.push(...decision.effects);
        }
        this.persistState(conversationId, state);
        for (const effect of effects) {
          this.persistEffect(conversationId, effect, outbox, deadlines);
        }
        settled = state;
      });
    } catch (error) {
      if (error instanceof Refused) return { ok: false, detail: error.message };
      throw error;
    }

    if (settled === undefined) return { ok: false, detail: "nothing was decided" };
    this.turns.set(conversationId, settled.inFlight);
    for (const { agentId, ms } of deadlines) this.armDeadline(conversationId, agentId, ms);
    for (const { agentId, frame } of outbox) this.deliver(agentId, frame);
    this.onRoomChange?.(conversationId);
    return { ok: true };
  }

  private apply(conversationId: string, event: TurnEvent): void {
    this.applyAll(conversationId, [event]);
  }

  private armDeadline(conversationId: string, agentId: string, ms: number = TURN_DEADLINE_MS): void {
    const key = Orchestrator.timerKey(conversationId, agentId);
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.apply(conversationId, { kind: "deadline", agent: agentId });
      }, ms),
    );
  }

  private clearDeadline(conversationId: string, agentId: string): void {
    const key = Orchestrator.timerKey(conversationId, agentId);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }

  private queueFanOut(conversationId: string, message: Message, outbox: Outbound[]): void {
    for (const agentId of this.store.conversationParticipantIds(conversationId) ?? []) {
      outbox.push({ agentId, frame: { t: "appended", message } });
    }
  }

  private budgetFrames(conversationId: string): Outbound[] {
    const participants = this.store.conversationParticipantIds(conversationId);
    if (participants === undefined) return [];
    const spend = this.store.spend(conversationId);
    const conversation = this.store.conversation(conversationId);
    const frame: ServerFrame = {
      t: "budget",
      conversationId,
      remaining: this.store.budget(conversationId),
      limit: this.store.limitFor(conversationId),
      spentUSD: spend.usd,
      spendIncomplete: spend.incomplete,
      state: this.store.roomState(conversationId),
      // By handle, like the conversation carries it: the app never sees an agent id.
      bowedOut: conversation?.bowedOut ?? [],
    };
    return participants.map((agentId) => ({ agentId, frame }));
  }

  /* ---------------- what the hub calls ---------------- */

  /**
   * One agent's answer to a turn it was dispatched — the whole transition, atomically.
   *
   * Retiring the dispatch, appending what was said, charging it and settling the turn are one
   * write, so the order of them stops being something every caller has to know.
   *
   * A dispatch may be answered exactly once, which is what makes a captured frame useless to
   * replay: the second finds the turn spent and nothing is written.
   */
  said(
    conversationId: string,
    agentId: string,
    answer: {
      readonly kind: Extract<MessageKind, "agent" | "pass">;
      readonly text: string;
      readonly signature: Signature;
      readonly dispatch: string;
      readonly costUSD?: number;
      readonly costIncomplete: boolean;
      readonly closing: boolean;
    },
  ): Accepted {
    const spend: TurnEvent[] =
      answer.costUSD !== undefined || answer.costIncomplete
        ? [{ kind: "spend", usd: answer.costUSD ?? 0, incomplete: answer.costIncomplete }]
        : [];

    // A goodbye is delivered and closes in one step: settling as `spoke` first would dispatch
    // a reply to a farewell. A pass is recorded and wakes nobody — silence is not an argument.
    const outcome: TurnOutcome = answer.closing
      ? "closed"
      : answer.kind === "pass"
        ? "passed"
        : "spoke";
    const wake: TurnEvent[] =
      answer.closing || answer.kind === "pass" ? [] : [{ kind: "message", author: agentId }];

    const accepted = this.applyAll(
      conversationId,
      [...spend, { kind: "settled", agent: agentId, outcome }, ...wake],
      (outbox) => {
        if (!this.store.settleDispatch(conversationId, agentId, answer.dispatch)) {
          throw new Refused("that turn is not yours to answer, or has been answered already");
        }
        const message = this.store.appendMessage({
          conversationId,
          authorAgentId: agentId,
          kind: answer.kind,
          text: answer.text,
          signature: answer.signature,
        });
        if (message === undefined) throw new Refused("that message could not be recorded");
        this.queueFanOut(conversationId, message, outbox);
      },
    );

    if (accepted.ok) this.clearDeadline(conversationId, agentId);
    return accepted;
  }

  /**
   * A turn that produced no message: the run failed, and the room should say why.
   *
   * The dispatch is spent either way, so a retry costs another one rather than reusing this.
   */
  troubled(conversationId: string, agentId: string, dispatch: string, reason: string): Accepted {
    const accepted = this.applyAll(
      conversationId,
      [{ kind: "settled", agent: agentId, outcome: "failed" }],
      (outbox) => {
        if (!this.store.settleDispatch(conversationId, agentId, dispatch)) {
          throw new Refused("that turn is not yours to answer, or has been answered already");
        }
        const message = this.store.appendMessage({
          conversationId,
          authorAgentId: agentId,
          kind: "system",
          text: reason,
        });
        if (message === undefined) throw new Refused("that note could not be recorded");
        this.queueFanOut(conversationId, message, outbox);
      },
    );
    if (accepted.ok) this.clearDeadline(conversationId, agentId);
    return accepted;
  }

  onNudge(conversationId: string, agentId: string, steer: string): void {
    this.apply(conversationId, { kind: "steer", agent: agentId, text: steer });
  }

  /**
   * Ask an agent to take the first turn, with no instruction attached.
   *
   * The hub used to start a room by filing the purpose as a steer, which put the hub's own
   * words in the one field the agent is told to obey ahead of everything else. Sealed steers
   * make that unacceptable rather than merely untidy: a bridge can no longer tell an owner's
   * instruction from the hub's by looking, so the hub does not get to write one. The purpose
   * already reaches the agent as `purpose`, and starting a room needs nothing more than a poke.
   */
  onBegin(conversationId: string, agentId: string): void {
    this.apply(conversationId, { kind: "steer", agent: agentId });
  }
  setLimit(conversationId: string, limit: Limit): void {
    this.apply(conversationId, { kind: "limit", limit });
  }

  stop(conversationId: string): void {
    this.apply(conversationId, { kind: "stop" });
  }

  reopen(conversationId: string): void {
    this.apply(conversationId, { kind: "reopen" });
  }

  /** Somebody joined one room. Ask their agent for whatever the room has been holding. */
  onJoined(conversationId: string, agentId: string): void {
    this.apply(conversationId, { kind: "arrived", agent: agentId });
  }

  /** Somebody left one room. Call after the store no longer counts them a member. */
  onLeft(conversationId: string, agentId: string): void {
    this.clearDeadline(conversationId, agentId);
    this.apply(conversationId, { kind: "left", agent: agentId });
  }

  /**
   * Forget a room outright. Call once its rows are already gone, in place of `onLeft` —
   * there is no state left for the turn policy to read, so there is nothing left to decide.
   */
  discard(conversationId: string, participants: readonly string[]): void {
    for (const agentId of participants) this.clearDeadline(conversationId, agentId);
    this.turns.delete(conversationId);
  }

  /**
   * A bridge came back. Ask it for anything the room has been holding.
   *
   * Without this a conversation only moved while both bridges happened to be up at once:
   * anything said to an agent that was away was never dispatched, and nothing afterwards
   * re-asked. Called after `replayTurns`, which covers the other half — work already
   * charged for and merely undelivered.
   */
  onArrived(agentId: string): void {
    for (const conversation of this.store.conversationsFor(agentId)) {
      this.apply(conversation.id, { kind: "arrived", agent: agentId });
    }
  }

  /**
   * Pick up the turns the previous process was waiting on. Called once at boot.
   *
   * Nothing is dispatched — there are no sockets yet — so each turn only gets its deadline
   * back, measured from when it was charged rather than from now. One already past arms at
   * zero and fires on the next tick, deliberately after the caller has finished wiring up.
   *
   * `now` is a parameter so a test can place a recovered turn either side of its deadline.
   */
  recover(now: number = Date.now()): void {
    for (const { conversationId, agentId, dispatchedAt, entry } of this.store.allInFlight()) {
      this.turns.set(conversationId, {
        ...(this.turns.get(conversationId) ?? {}),
        [agentId]: entry,
      });
      const elapsed = now - new Date(dispatchedAt).getTime();
      this.armDeadline(conversationId, agentId, Math.max(0, TURN_DEADLINE_MS - elapsed));
    }
  }

  /**
   * A socket dropped. The turn stays in flight — a laptop sleep must not eat a charged
   * dispatch — and the deadline still fires if they never come back.
   */
  onDisconnect(_agentId: string): void {}

  /**
   * Re-deliver every in-flight turn for this agent without charging again.
   *
   * The same dispatch id goes back out, because it is the same turn: a fresh one would strand
   * whatever the bridge is already holding.
   */
  replayTurns(agentId: string): void {
    for (const [conversationId, inFlight] of this.turns) {
      const entry = inFlight[agentId];
      if (entry === undefined) continue;
      const outbox: Outbound[] = [];
      const deadlines: { agentId: string; ms: number }[] = [];
      // Nothing durable changes: the dispatch row and the charge are already there, so this
      // borrows the effect writer purely for the frame it builds.
      this.persistEffect(
        conversationId,
        {
          kind: "dispatch",
          agent: agentId,
          dispatch: entry.dispatch,
          ...(entry.dispatchSteer !== undefined ? { steer: entry.dispatchSteer } : {}),
        },
        outbox,
        deadlines,
      );
      for (const { agentId: target, ms } of deadlines) this.armDeadline(conversationId, target, ms);
      for (const { agentId: target, frame } of outbox) this.deliver(target, frame);
    }
  }

  /**
   * The bridge says this turn is still running, so give it the deadline back.
   *
   * The deadline notices a bridge that has gone away; it does not cap how long an agent may
   * think. Without a heartbeat the two were one number — see `docs/design.md` §4.
   */
  onProgress(conversationId: string, agentId: string): void {
    const inFlight = this.turns.get(conversationId);
    if (inFlight?.[agentId] === undefined) return;
    this.armDeadline(conversationId, agentId);
  }

  /** The owner is deciding something; keep the turn, give them time. */
  onWaiting(conversationId: string, agentId: string): void {
    const inFlight = this.turns.get(conversationId);
    if (inFlight?.[agentId] === undefined) return;
    this.armDeadline(conversationId, agentId, APPROVAL_DEADLINE_MS);
  }

  hasTurn(conversationId: string, agentId: string): boolean {
    return this.turns.get(conversationId)?.[agentId] !== undefined;
  }

  announceBudget(conversationId: string): void {
    for (const { agentId, frame } of this.budgetFrames(conversationId)) {
      this.deliver(agentId, frame);
    }
  }
}
