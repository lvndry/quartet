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
import type { Limit } from "@quartet/protocol";

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
  /**
   * An owner's instruction that arrived while the agent was already thinking.
   *
   * Carried to the follow-up turn rather than dropped with the rest of the coalescing: a
   * message can be collapsed because the transcript already holds it, but a steer exists
   * nowhere else, and losing it means the agent never hears what its owner asked for. The
   * latest wins — somebody typing twice means the second thing.
   */
  steer?: string;
  /** Whether the turn now running was asked for by its owner. */
  readonly steered: boolean;
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
    // Topping the allowance up restarts a room that has gone quiet. A room still running
    // gets the steer and nothing else — somebody typing into a live argument is as likely to
    // be reining it in as egging it on, and refilling there means "stop" buys it more turns.
    this.store.setStopped(conversationId, false);
    const limit = this.store.limitFor(conversationId);
    if (limit.kind === "turns" && this.store.budget(conversationId) <= 0) {
      this.store.setBudget(conversationId, limit.turns);
    }
    this.broadcastBudget(conversationId, participants);
    this.poke(conversationId, agentId, steer);
  }

  /**
   * Deliver one last message, then close.
   *
   * The message reaches both sides and nobody is woken to answer it, so an agent bowing out
   * can say so instead of falling silent.
   */
  closeWith(conversationId: string, message: Message): void {
    const participants = this.store.conversationParticipantIds(conversationId);
    if (participants === undefined) return;
    for (const agentId of participants) this.deliver(agentId, { t: "appended", message });
    this.stop(conversationId);
  }

  /** Push the current spending position to both sides. */
  announceBudget(conversationId: string): void {
    const participants = this.store.conversationParticipantIds(conversationId);
    if (participants !== undefined) this.broadcastBudget(conversationId, participants);
  }

  /** Record what a turn cost, when the daemon could tell us. */
  onSpend(conversationId: string, costUSD: number | undefined, incomplete: boolean): void {
    // An unpriced turn still latches the flag: a total that silently omits some spend is
    // worse than one openly marked as a floor.
    if (costUSD === undefined && !incomplete) return;
    this.store.addSpend(conversationId, costUSD ?? 0, incomplete);
    const participants = this.store.conversationParticipantIds(conversationId);
    if (participants !== undefined) this.broadcastBudget(conversationId, participants);
  }

  /**
   * A turn settled — the agent spoke, passed, or failed. Run any follow-up that queued up.
   *
   * A pass on a turn its owner asked for runs no follow-up, unless the owner has since asked
   * for something else. Typing "stop" and watching the agent fall silent and then speak
   * anyway is being ignored twice over; a newer instruction is the one case where speaking
   * again is what was actually wanted.
   */
  onTurnSettled(conversationId: string, agentId: string, passed = false): void {
    const key = Orchestrator.key(conversationId, agentId);
    const entry = this.inFlight.get(key);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.inFlight.delete(key);
    if (passed && entry.steered && entry.steer === undefined) return;
    if (entry.pending) this.poke(conversationId, agentId, entry.steer);
  }

  /**
   * Stop a conversation now.
   *
   * Drops the remaining budget to zero and forgets any queued follow-up, so an in-flight turn
   * finishes and nothing new is dispatched. The kill switch that makes an unlimited ceiling
   * something other than a way to spend money unattended.
   */
  stop(conversationId: string): void {
    this.store.setStopped(conversationId, true);
    for (const [key, entry] of this.inFlight) {
      if (key.startsWith(`${conversationId}::`)) entry.pending = false;
    }
    const participants = this.store.conversationParticipantIds(conversationId);
    if (participants !== undefined) this.broadcastBudget(conversationId, participants);
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
      if (steer !== undefined) existing.steer = steer;
      return;
    }

    if (!this.isOnline(agentId)) return;

    const limit = this.store.limitFor(conversationId);
    if (!this.canSpend(conversationId, limit)) return;

    const conversation = this.store.conversation(conversationId);
    if (conversation === undefined) return;

    // Only a turn rule counts down. Under a cost rule the meter is the money, and under no
    // rule there is nothing to count — the pass gate and the stop control end it instead.
    if (limit.kind === "turns") {
      this.store.setBudget(conversationId, this.store.budget(conversationId) - 1);
    }
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

    this.inFlight.set(key, { timer, pending: false, steered: steer !== undefined });

    this.deliver(agentId, {
      t: "turn",
      conversationId,
      purpose: conversation.purpose,
      transcript: this.store.transcript(conversationId, TRANSCRIPT_WINDOW),
      ...(steer !== undefined ? { steer } : {}),
    });
  }

  private broadcastBudget(conversationId: string, participants: readonly string[]): void {
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

  /**
   * Whether this conversation may spend another turn.
   *
   * Each rule answers a different question, and none of them substitutes for the others: a
   * turn of a local model is free, and a turn of a frontier model with tool calls is not.
   *
   * An unpriced run is deliberately *not* treated as free under a cost rule — `spentUSD`
   * would then be a floor that never rises, and the ceiling would never be reached. Such a
   * conversation falls back to the turn ceiling so it still ends somewhere.
   */
  private canSpend(conversationId: string, limit: Limit): boolean {
    if (this.store.isStopped(conversationId)) return false;
    switch (limit.kind) {
      case "turns":
        return this.store.budget(conversationId) > 0;
      case "cost": {
        const spend = this.store.spend(conversationId);
        if (spend.incomplete) return this.store.budget(conversationId) > 0;
        return spend.usd < limit.usd;
      }
      case "none":
        return true;
      default:
        return false;
    }
  }
}
