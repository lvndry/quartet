/**
 * @fileoverview Deciding who speaks next, and making sure it stops.
 *
 * Two agents that each answer the other's answer never stop, and every lap is a real model
 * call on somebody's real key. So this is the only part of the hub with genuine difficulty
 * in it, and the difficulty is entirely about *not* dispatching.
 *
 * Three mechanisms, layered, none sufficient alone:
 *
 * - **A turn budget** caps how many agent turns one human message can set off. It is a hard
 *   ceiling that survives a misbehaving model, and when it runs out the room simply goes
 *   quiet until a person speaks again.
 * - **One in-flight turn per agent per conversation.** Messages arriving while an agent is
 *   thinking collapse into a single follow-up instead of stacking dispatches. This is what
 *   stops the same turn being paid for twice.
 * - **A deadline.** A bridge that accepts a turn and never answers would otherwise hold the
 *   in-flight slot forever, and the conversation would look alive while being dead.
 *
 * Budget is charged at *dispatch*, not at reply, because dispatch is the moment the cost is
 * incurred. An agent that passes has still run a model.
 */

import type { HubStore } from "./db";
import type { Message, ServerFrame } from "@quartet/protocol";
import { DEFAULT_TURN_BUDGET } from "@quartet/protocol";

/** How much of the conversation an agent is shown. The agent is stateless between turns. */
const TRANSCRIPT_WINDOW = 40;

/**
 * How long a bridge has to answer a dispatched turn.
 *
 * Generous on purpose: a local model on a cold load can take a long time, and treating that
 * as failure would make the product feel broken precisely for the users running it the way
 * it is meant to be run.
 */
const TURN_DEADLINE_MS = 180_000;

interface InFlight {
  readonly timer: ReturnType<typeof setTimeout>;
  /** Set when new messages land mid-turn, so exactly one follow-up runs when this settles. */
  pending: boolean;
}

export type Deliver = (agentId: string, frame: ServerFrame) => void;
export type IsOnline = (agentId: string) => boolean;

export class Orchestrator {
  private readonly inFlight = new Map<string, InFlight>();

  constructor(
    private readonly store: HubStore,
    private readonly deliver: Deliver,
    private readonly isOnline: IsOnline,
  ) {}

  private static key(conversationId: string, agentId: string): string {
    return `${conversationId}::${agentId}`;
  }

  /**
   * A message landed. Fan it out, then consider waking the other party.
   *
   * The author is never woken by their own message — that is the base case that keeps a
   * single agent from talking to itself forever.
   */
  onMessage(conversationId: string, authorAgentId: string, message: Message): void {
    const participants = this.store.conversationParticipantIds(conversationId);
    if (participants === undefined) return;

    for (const agentId of participants) {
      this.deliver(agentId, { t: "appended", message });
    }

    const other = participants.find((agentId) => agentId !== authorAgentId);
    if (other !== undefined) this.poke(conversationId, other);
  }

  /**
   * The owner said something to their own agent.
   *
   * This is the only thing that refills the budget, which is what makes the ceiling
   * meaningful: an unattended conversation spends its allowance and then waits for a person.
   * The steer itself is never stored — it goes to one agent, once, as an instruction.
   */
  onNudge(conversationId: string, agentId: string, steer: string): void {
    const participants = this.store.conversationParticipantIds(conversationId);
    if (participants === undefined || !participants.includes(agentId)) return;
    this.store.setBudget(conversationId, DEFAULT_TURN_BUDGET);
    this.broadcastBudget(conversationId, participants);
    this.poke(conversationId, agentId, steer);
  }

  /** A turn settled — the agent spoke, passed, or failed. Run any follow-up that queued up. */
  onTurnSettled(conversationId: string, agentId: string): void {
    const key = Orchestrator.key(conversationId, agentId);
    const entry = this.inFlight.get(key);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.inFlight.delete(key);
    if (entry.pending) this.poke(conversationId, agentId);
  }

  /** A bridge went away. Nothing it was thinking about is coming back. */
  onDisconnect(agentId: string): void {
    for (const [key, entry] of [...this.inFlight]) {
      if (key.endsWith(`::${agentId}`)) {
        clearTimeout(entry.timer);
        this.inFlight.delete(key);
      }
    }
  }

  /**
   * Consider dispatching a turn to one agent.
   *
   * Every early return here is a reason *not* to spend money, which is why they are all in
   * one place rather than spread across the callers.
   */
  private poke(conversationId: string, agentId: string, steer?: string): void {
    const key = Orchestrator.key(conversationId, agentId);

    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      // Already thinking. Collapse whatever arrived into one follow-up rather than queueing
      // a dispatch per message — otherwise a burst of three messages is billed three times.
      existing.pending = true;
      return;
    }

    if (!this.isOnline(agentId)) return;

    const remaining = this.store.budget(conversationId);
    if (remaining <= 0) return;

    const conversation = this.store.conversation(conversationId);
    if (conversation === undefined) return;

    this.store.setBudget(conversationId, remaining - 1);
    const participants = this.store.conversationParticipantIds(conversationId);
    if (participants !== undefined) this.broadcastBudget(conversationId, participants);

    const timer = setTimeout(() => {
      this.inFlight.delete(key);
      const stalled = this.store.appendMessage({
        conversationId,
        authorAgentId: agentId,
        kind: "system",
        text: "no answer in time",
      });
      if (stalled !== undefined && participants !== undefined) {
        for (const participant of participants) {
          this.deliver(participant, { t: "appended", message: stalled });
        }
      }
    }, TURN_DEADLINE_MS);

    this.inFlight.set(key, { timer, pending: false });

    this.deliver(agentId, {
      t: "turn",
      conversationId,
      purpose: conversation.purpose,
      transcript: this.store.transcript(conversationId, TRANSCRIPT_WINDOW),
      ...(steer !== undefined ? { steer } : {}),
    });
  }

  private broadcastBudget(conversationId: string, participants: readonly string[]): void {
    const remaining = this.store.budget(conversationId);
    for (const agentId of participants) {
      this.deliver(agentId, { t: "budget", conversationId, remaining });
    }
  }
}
