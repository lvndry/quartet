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
      stopped: this.store.isStopped(conversationId),
      inFlight: this.turns.get(conversationId) ?? {},
    };
  }

  private write(conversationId: string, state: TurnState): void {
    this.store.setBudget(conversationId, state.turnsLeft);
    this.store.setStopped(conversationId, state.stopped);
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

  private armDeadline(conversationId: string, agentId: string): void {
    const key = Orchestrator.timerKey(conversationId, agentId);
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.apply(conversationId, { kind: "deadline", agent: agentId });
      }, TURN_DEADLINE_MS),
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

  onDisconnect(agentId: string): void {
    for (const conversationId of [...this.turns.keys()]) {
      this.clearDeadline(conversationId, agentId);
      this.apply(conversationId, { kind: "offline", agent: agentId });
    }
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
      stopped: this.store.isStopped(conversationId),
    };
    for (const agentId of participants) this.deliver(agentId, frame);
  }
}
