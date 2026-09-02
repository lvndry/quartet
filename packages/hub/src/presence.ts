/**
 * @fileoverview Who is in a room, and whether their agent is mid-turn.
 *
 * Online is the bridge socket. Watching is a browser looking at this conversation. Thinking
 * is a dispatched turn that has not settled. The three are different, and the product is
 * dishonest if it only ever shows your own side.
 */

import type { HubStore } from "./db";
import type { Deliver, IsOnline } from "./orchestrator";

export type IsThinking = (conversationId: string, agentId: string) => boolean;

export class RoomPresence {
  /** Which conversation each agent last said they were looking at. */
  private readonly watching = new Map<string, string>();
  /** When we first observed a turn in flight, so elapsed time survives repeated announces. */
  private readonly thinkingSince = new Map<string, number>();

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

  announce(conversationId: string): void {
    const ids = this.store.conversationParticipantIds(conversationId);
    if (ids === undefined) return;
    for (const agentId of ids) {
      const otherId = ids.find((candidate) => candidate !== agentId);
      if (otherId === undefined) continue;
      const other = this.store.agentById(otherId);
      if (other === undefined) continue;
      const thinking = this.isThinking(conversationId, otherId);
      const key = `${conversationId}::${otherId}`;
      let since: number | undefined;
      if (thinking) {
        since = this.thinkingSince.get(key) ?? Date.now();
        this.thinkingSince.set(key, since);
      } else {
        this.thinkingSince.delete(key);
      }
      this.send(agentId, {
        t: "presence",
        conversationId,
        other: {
          handle: other.handle,
          online: this.isOnline(otherId),
          watching: this.watching.get(otherId) === conversationId,
          thinking,
          ...(since !== undefined ? { since } : {}),
        },
      });
    }
  }
}
