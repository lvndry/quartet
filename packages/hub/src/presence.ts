/**
 * @fileoverview Who is in a room, and whether their agent is mid-turn.
 *
 * Online is the bridge socket. Watching is a browser looking at this conversation. Thinking
 * is a dispatched turn that has not settled. The three are different, and the product is
 * dishonest if it only ever shows your own side.
 */

import type { PeerPresence } from "@quartet/protocol";
import type { HubStore } from "./db";
import type { Deliver, IsOnline } from "./orchestrator";

export type IsThinking = (conversationId: string, agentId: string) => boolean;

export class RoomPresence {
  /** Which conversation each agent last said they were looking at. */
  private readonly watching = new Map<string, string>();
  /** When we first observed a turn in flight, so elapsed time survives repeated announces. */
  private readonly thinkingSince = new Map<string, number>();
  /** The last thing a bridge said its agent was doing, per room and agent. */
  private readonly doing = new Map<string, string>();

  constructor(
    private readonly store: HubStore,
    private readonly send: Deliver,
    private readonly isOnline: IsOnline,
    private readonly isThinking: IsThinking,
  ) {}

  watch(agentId: string, conversationId: string | undefined): void {
    const previous = this.watching.get(agentId);
    if (conversationId === undefined) this.watching.delete(agentId);
    else this.watching.set(agentId, conversationId);
    if (previous !== undefined && previous !== conversationId) this.announce(previous);
    if (conversationId !== undefined) this.announce(conversationId);
  }

  /**
   * What this agent is doing, as its own bridge last reported.
   *
   * Cleared when the turn ends, so a finished tool name does not sit there looking live.
   */
  note(conversationId: string, agentId: string, doing: string | undefined): void {
    const key = `${conversationId}::${agentId}`;
    if (doing === undefined) this.doing.delete(key);
    else this.doing.set(key, doing);
    this.announce(conversationId);
  }

  /** Bridge gone: they are neither online nor watching. */
  clear(agentId: string): void {
    this.watching.delete(agentId);
    this.announceAll(agentId);
  }

  announceAll(agentId: string): void {
    for (const conversation of this.store.conversationsFor(agentId)) {
      this.announce(conversation.id);
    }
  }

  /** One member's state, and the bookkeeping that keeps their elapsed time honest. */
  private view(conversationId: string, agentId: string): PeerPresence | undefined {
    const agent = this.store.agentById(agentId);
    if (agent === undefined) return undefined;
    const thinking = this.isThinking(conversationId, agentId);
    const key = `${conversationId}::${agentId}`;
    let since: number | undefined;
    if (thinking) {
      since = this.thinkingSince.get(key) ?? Date.now();
      this.thinkingSince.set(key, since);
    } else {
      this.thinkingSince.delete(key);
      this.doing.delete(key);
    }
    return {
      handle: agent.handle,
      online: this.isOnline(agentId),
      watching: this.watching.get(agentId) === conversationId,
      thinking,
      ...(since !== undefined ? { since } : {}),
      ...(thinking && this.doing.get(key) !== undefined
        ? { doing: this.doing.get(key) as string }
        : {}),
    };
  }

  announce(conversationId: string): void {
    const ids = this.store.conversationParticipantIds(conversationId);
    if (ids === undefined) return;

    // Built once per member and then handed out, rather than once per pair. In a room of
    // six the difference is five reads instead of thirty, and it also means everybody is
    // told the same thing about the same person.
    const views = new Map<string, PeerPresence>();
    for (const agentId of ids) {
      const view = this.view(conversationId, agentId);
      if (view !== undefined) views.set(agentId, view);
    }

    for (const agentId of ids) {
      this.send(agentId, {
        t: "presence",
        conversationId,
        others: ids.flatMap((candidate) => {
          if (candidate === agentId) return [];
          const view = views.get(candidate);
          return view === undefined ? [] : [view];
        }),
      });
    }
  }
}
