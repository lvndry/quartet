/**
 * @fileoverview Applying what the turn policy decides.
 *
 * The reasoning lives in `turn-policy.ts` as a pure function; this holds the live pieces it
 * cannot touch — the socket registry, the database, the deadline timers — and moves state
 * between them. Splitting it that way is what lets every rule have a test that runs in
 * milliseconds rather than only through a scripted conversation.
 */

import type { HubStore } from "./db";
import { decide, type TurnEffect, type TurnEvent, type TurnOutcome, type TurnState } from "./turn-policy";
import type { Limit, Message, ServerFrame } from "@quartet/protocol";

/** How much of the conversation an agent is shown. The agent is stateless between turns. */
const TRANSCRIPT_WINDOW = 40;

/**
 * How long a bridge has to answer a dispatched turn.
 *
 * Generous on purpose: a local model on a cold load can take a long time, and treating that
 * as failure would make the product feel broken precisely for the people running it the way
 * it is meant to be run.
 */
const TURN_DEADLINE_MS = 180_000;

/** A parked tool waits on a person, not on the model. Three minutes is not enough. */
const APPROVAL_DEADLINE_MS = 15 * 60_000;

export type Deliver = (agentId: string, frame: ServerFrame) => void;
export type IsOnline = (agentId: string) => boolean;

export class Orchestrator {
  /** In-memory turn bookkeeping per conversation; the database holds the durable half. */
  private readonly turns = new Map<string, TurnState["inFlight"]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: HubStore,
    private readonly deliver: Deliver,
    private readonly isOnline: IsOnline,
    private readonly onRoomChange?: (conversationId: string) => void,
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
      inFlight: this.turns.get(conversationId) ?? {},
    };
  }

  /**
   * Persist everything the policy just decided, in-flight turns included.
   *
   * The turn bookkeeping used to live only in `this.turns`, while the charge for it went
   * straight to disk. A hub restart mid-turn therefore left a conversation paid up and
   * permanently silent: no entry to replay on the next hello, no deadline left to fire, and
   * nothing in the transcript to say why. `recover` reads these rows back.
   */
  private write(conversationId: string, state: TurnState): void {
    this.store.setBudget(conversationId, state.turnsLeft);
    this.store.setState(conversationId, state.roomState);
    this.store.setSpend(conversationId, state.spentUSD, state.spendIncomplete);

    const before = this.turns.get(conversationId) ?? {};
    for (const agentId of Object.keys(before)) {
      if (state.inFlight[agentId] === undefined) this.store.clearInFlight(conversationId, agentId);
    }
    for (const [agentId, entry] of Object.entries(state.inFlight)) {
      this.store.saveInFlight(conversationId, agentId, entry);
    }
    this.turns.set(conversationId, state.inFlight);
  }

  private apply(conversationId: string, event: TurnEvent): void {
    const before = this.read(conversationId);
    if (before === undefined) return;
    const { state, effects } = decide(before, event);
    // A limit change is the one event that rewrites the rule itself, so it is persisted
    // through the store's own setter, which keeps the turn ceiling in step with it.
    if (event.kind === "limit") this.store.setLimit(conversationId, state.limit);
    this.write(conversationId, state);
    for (const effect of effects) this.run(conversationId, effect);
    this.onRoomChange?.(conversationId);
  }

  private run(conversationId: string, effect: TurnEffect): void {
    switch (effect.kind) {
      case "dispatch": {
        const conversation = this.store.conversation(conversationId);
        if (conversation === undefined) return;
        this.armDeadline(conversationId, effect.agent);
        this.deliver(effect.agent, {
          t: "turn",
          conversationId,
          purpose: conversation.purpose,
          transcript: this.store.transcript(conversationId, TRANSCRIPT_WINDOW),
          ...(effect.steer !== undefined ? { steer: effect.steer } : {}),
          ...(effect.notice !== undefined ? { notice: effect.notice } : {}),
        });
        return;
      }

      case "announce":
        this.announceBudget(conversationId);
        return;

      case "note": {
        const message = this.store.appendMessage({
          conversationId,
          authorAgentId: effect.agent,
          kind: "system",
          text: effect.text,
        });
        if (message !== undefined) this.fanOut(conversationId, message);
        return;
      }

      default:
        return;
    }
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

  private fanOut(conversationId: string, message: Message): void {
    for (const agentId of this.store.conversationParticipantIds(conversationId) ?? []) {
      this.deliver(agentId, { t: "appended", message });
    }
  }

  /* ---------------- what the hub calls ---------------- */

  onMessage(conversationId: string, authorAgentId: string, message: Message): void {
    this.fanOut(conversationId, message);
    this.apply(conversationId, { kind: "message", author: authorAgentId });
  }

  /** Delivered to both sides, then closed, so a goodbye is never answered. */
  closeWith(conversationId: string, agentId: string, message: Message): void {
    this.fanOut(conversationId, message);
    this.clearDeadline(conversationId, agentId);
    this.apply(conversationId, { kind: "settled", agent: agentId, outcome: "closed" });
  }

  onNudge(conversationId: string, agentId: string, steer: string): void {
    this.apply(conversationId, { kind: "steer", agent: agentId, text: steer });
  }

  onTurnSettled(conversationId: string, agentId: string, outcome: TurnOutcome): void {
    this.clearDeadline(conversationId, agentId);
    this.apply(conversationId, { kind: "settled", agent: agentId, outcome });
  }

  onSpend(conversationId: string, costUSD: number | undefined, incomplete: boolean): void {
    if (costUSD === undefined && !incomplete) return;
    this.apply(conversationId, { kind: "spend", usd: costUSD ?? 0, incomplete });
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

  /**
   * Pick up the turns the previous process was waiting on.
   *
   * Called once at boot, before any bridge can connect. Nothing is dispatched here — there
   * are no sockets yet — so each turn only gets its deadline back, measured from when it
   * was charged rather than from now. A bridge that reconnects has its work re-delivered by
   * `replayTurns`; one that never does trips the deadline and the room says so.
   *
   * A deadline already past arms at zero and fires on the next tick, which is deliberately
   * after the caller has finished wiring the hub up.
   *
   * `now` is a parameter so a test can place a recovered turn either side of its deadline
   * without waiting three minutes for one.
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
   * A socket dropped. The turn stays in flight: a laptop sleep or a replaced
   * connection must not eat a charged dispatch. The deadline still fires if they
   * never come back. `replayTurns` re-delivers the work on the next hello.
   */
  onDisconnect(_agentId: string): void {}

  /** Re-deliver every in-flight turn for this agent without charging again. */
  replayTurns(agentId: string): void {
    for (const [conversationId, inFlight] of this.turns) {
      const entry = inFlight[agentId];
      if (entry === undefined) continue;
      this.run(conversationId, {
        kind: "dispatch",
        agent: agentId,
        ...(entry.dispatchSteer !== undefined ? { steer: entry.dispatchSteer } : {}),
      });
    }
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
    const participants = this.store.conversationParticipantIds(conversationId);
    if (participants === undefined) return;
    const spend = this.store.spend(conversationId);
    const frame = {
      t: "budget" as const,
      conversationId,
      remaining: this.store.budget(conversationId),
      limit: this.store.limitFor(conversationId),
      spentUSD: spend.usd,
      spendIncomplete: spend.incomplete,
      state: this.store.roomState(conversationId),
    };
    for (const agentId of participants) this.deliver(agentId, frame);
  }
}
