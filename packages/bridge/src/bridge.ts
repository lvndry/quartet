/**
 * @fileoverview The bridge: your half of quartet, running on your machine.
 *
 * It holds one outbound socket to the hub and talks to jazz over loopback, which is what
 * lets anyone take part without exposing a port, a tunnel, or a public daemon.
 *
 * It is also the app's backend. The browser talks to *this*, not to the hub — so the page
 * reading your ledger is same-origin with the process that holds it, and the awkward
 * request (a public page reaching into a private network) never has to exist.
 *
 * State is mirrored rather than queried: the hub pushes, the bridge keeps a copy, and the
 * browser gets the whole snapshot on every change. For a two-person conversation that is a
 * few kilobytes, and it buys the absence of a second incremental protocol to keep in step.
 */

import {
  parseServerFrame,
  type ClientFrame,
  type Connection,
  type Conversation,
  type DirectoryEntry,
  type Invite,
  type Message,
  type Agent,
} from "@quartet/protocol";
import type { DaemonSettings } from "./config";
import { runTurn } from "./jazz";
import { recordSent, readLedger, type LedgerEntry } from "./ledger";
import { logger } from "./log";
import { buildPayload } from "./prompt";

/** What your own agent is doing right now, per conversation. Drives the UI's live states. */
export type Activity =
  | { readonly state: "idle" }
  | { readonly state: "thinking"; readonly since: number }
  | { readonly state: "needs-you"; readonly runId: string };

/** An aside you typed to your own agent. Local only — it never reaches the other party. */
export interface Aside {
  readonly at: string;
  readonly conversationId: string;
  readonly text: string;
}

export interface BridgeState {
  readonly connectedToHub: boolean;
  readonly me?: Agent;
  readonly connections: Connection[];
  readonly conversations: Conversation[];
  readonly invites: Invite[];
  readonly directory: DirectoryEntry[];
  readonly messages: Record<string, Message[]>;
  readonly asides: Record<string, Aside[]>;
  readonly activity: Record<string, Activity>;
  readonly ledger: LedgerEntry[];
  readonly lastError?: string;
}

const log = logger("bridge");
const hubLog = logger("hub");
const daemonLog = logger("daemon");

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class Bridge {
  private socket?: WebSocket;
  private reconnectDelay = RECONNECT_MIN_MS;
  private closing = false;
  private readonly listeners = new Set<(state: BridgeState) => void>();

  private connectedToHub = false;
  private me: Agent | undefined;
  private connections: Connection[] = [];
  private conversations: Conversation[] = [];
  private invites: Invite[] = [];
  private directory: DirectoryEntry[] = [];
  private readonly messages = new Map<string, Message[]>();
  private readonly asides = new Map<string, Aside[]>();
  private readonly activity = new Map<string, Activity>();
  private ledger: LedgerEntry[] = [];
  private lastError: string | undefined;
  /**
   * What the owner asked for, per conversation, until the resulting message comes back.
   *
   * Held here rather than passed through the send because the ledger is written when the hub
   * confirms, by which point the turn that produced it is long over.
   */
  private readonly pendingSteer = new Map<string, string>();

  constructor(
    private readonly hubUrl: string,
    private readonly agentToken: string,
    private readonly daemon: DaemonSettings,
  ) {}

  async start(): Promise<void> {
    this.ledger = await readLedger();
    this.open();
  }

  stop(): void {
    this.closing = true;
    this.socket?.close();
  }

  subscribe(listener: (state: BridgeState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): BridgeState {
    return {
      connectedToHub: this.connectedToHub,
      ...(this.me !== undefined ? { me: this.me } : {}),
      connections: this.connections,
      conversations: this.conversations,
      invites: this.invites,
      directory: this.directory,
      messages: Object.fromEntries(this.messages),
      asides: Object.fromEntries(this.asides),
      activity: Object.fromEntries(this.activity),
      ledger: this.ledger,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  private publish(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }

  /** Send a frame to the hub. Dropped silently when offline — the hub resends state on reconnect. */
  send(frame: ClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  /**
   * Say something to your own agent.
   *
   * Kept locally and shown only to you, then handed to the hub as a nudge — which refills the
   * turn budget and asks your agent to move. Your words are an instruction to your agent, not
   * a message to the other party, so they never enter the shared transcript.
   */
  nudge(conversationId: string, text: string): void {
    const aside: Aside = { at: new Date().toISOString(), conversationId, text };
    this.asides.set(conversationId, [...(this.asides.get(conversationId) ?? []), aside]);
    log.info("you → your agent", { conversation: conversationId, chars: text.length });
    this.publish();
    this.send({ t: "nudge", conversationId, steer: text });
  }

  private open(): void {
    const url = new URL("/socket", this.hubUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url.toString());
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.connectedToHub = true;
      this.lastError = undefined;
      hubLog.info("connected", { url: this.hubUrl });
      socket.send(JSON.stringify({ t: "hello", agentToken: this.agentToken } satisfies ClientFrame));
      this.publish();
    });

    socket.addEventListener("message", (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      const frame = parseServerFrame(raw);
      if (frame === undefined) {
        hubLog.debug("unparsed frame");
        return;
      }
      hubLog.debug(`← ${frame.t}`);
      void this.onFrame(frame);
    });

    socket.addEventListener("close", () => {
      this.connectedToHub = false;
      this.publish();
      if (this.closing) return;
      // Backoff, because a hub that is down stays down for a while and hammering it helps
      // nobody. Capped so a laptop that slept overnight still rejoins within half a minute.
      hubLog.warn("disconnected, retrying", { in: `${String(this.reconnectDelay)}ms` });
      setTimeout(() => this.open(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    });

    socket.addEventListener("error", () => {
      // `close` always follows, and that is where reconnection is handled. Swallowing here
      // keeps one reconnect path rather than two that can race.
    });
  }

  private async onFrame(frame: ReturnType<typeof parseServerFrame> & object): Promise<void> {
    switch (frame.t) {
      case "welcome":
        hubLog.info(`signed in as @${frame.me.handle}`, {
          conversations: frame.conversations.length,
          invites: frame.invites.length,
        });
        this.me = frame.me;
        this.connections = frame.connections;
        this.conversations = frame.conversations;
        this.invites = frame.invites;
        this.publish();
        return;

      case "directory":
        this.directory = frame.people;
        this.publish();
        return;

      case "invite":
        hubLog.info(`invite ${frame.invite.status}`, {
          from: `@${frame.invite.fromHandle}`,
          to: `@${frame.invite.toHandle}`,
        });
        this.invites = [frame.invite, ...this.invites.filter((i) => i.id !== frame.invite.id)];
        this.publish();
        return;

      case "connected":
        hubLog.info(`connected with @${frame.connection.withAgent.handle}`);
        this.connections = [
          frame.connection,
          ...this.connections.filter((c) => c.id !== frame.connection.id),
        ];
        this.conversations = [
          frame.conversation,
          ...this.conversations.filter((c) => c.id !== frame.conversation.id),
        ];
        this.publish();
        return;

      case "conversation":
        this.conversations = [
          frame.conversation,
          ...this.conversations.filter((c) => c.id !== frame.conversation.id),
        ];
        this.publish();
        return;

      case "appended": {
        const list = this.messages.get(frame.message.conversationId) ?? [];
        if (!list.some((message) => message.id === frame.message.id)) {
          this.messages.set(frame.message.conversationId, [...list, frame.message]);
        }
        // Our own message landing means our turn is over; anything else leaves us as we were.
        if (frame.message.authorHandle === this.me?.handle) {
          this.activity.set(frame.message.conversationId, { state: "idle" });
          await this.recordOutgoing(frame.message);
        }
        this.publish();
        return;
      }

      case "budget":
        hubLog.debug("budget", {
          conversation: frame.conversationId,
          left: frame.remaining,
          spent: frame.spentUSD.toFixed(4),
          stopped: frame.stopped ? "yes" : undefined,
        });
        this.conversations = this.conversations.map((conversation) =>
          conversation.id === frame.conversationId
            ? {
                ...conversation,
                budgetRemaining: frame.remaining,
                limit: frame.limit,
                spentUSD: frame.spentUSD,
                spendIncomplete: frame.spendIncomplete,
                stopped: frame.stopped,
              }
            : conversation,
        );
        this.publish();
        return;

      case "turn":
        await this.takeTurn(
      frame.conversationId,
      frame.purpose,
      frame.transcript,
      frame.steer,
      frame.notice,
    );
        return;

      case "error":
        hubLog.error(frame.detail);
        this.lastError = frame.detail;
        this.publish();
        return;

      default:
        return;
    }
  }

  /**
   * Write one confirmed outgoing message into the local record.
   *
   * Driven by the hub's confirmation rather than by our own send, so messages the hub
   * appends on our behalf — the invite's opening line, most obviously — are recorded too.
   * Without that, the ledger would quietly omit the first thing your agent ever said.
   */
  private async recordOutgoing(message: Message): Promise<void> {
    if (message.kind !== "agent") return;
    if (this.ledger.some((entry) => entry.id === message.id)) return;

    const conversation = this.conversations.find(
      (candidate) => candidate.id === message.conversationId,
    );
    const other =
      conversation?.participants.find((handle) => handle !== this.me?.handle) ?? "them";
    const steer = this.pendingSteer.get(message.conversationId);
    this.pendingSteer.delete(message.conversationId);

    const entry: LedgerEntry = {
      id: message.id,
      at: message.at,
      conversationId: message.conversationId,
      to: other,
      text: message.text,
      ...(steer !== undefined ? { steer } : {}),
    };
    this.ledger = [...this.ledger, entry];
    await recordSent(entry);
  }

  /**
   * Answer one dispatched turn by waking the local jazz agent.
   *
   * The thread key is the conversation id, so jazz resumes that conversation and nothing
   * else: two threads with the same person stay two separate memories.
   */
  private async takeTurn(
    conversationId: string,
    purpose: string,
    transcript: readonly Message[],
    steer: string | undefined,
    notice: string | undefined,
  ): Promise<void> {
    const me = this.me;
    if (me === undefined) return;

    const conversation = this.conversations.find((candidate) => candidate.id === conversationId);
    const other = conversation?.participants.find((handle) => handle !== me.handle) ?? "them";

    const startedAt = Date.now();
    daemonLog.info(`turn from @${other}`, { conversation: conversationId, steered: steer !== undefined ? "yes" : undefined });
    this.activity.set(conversationId, { state: "thinking", since: startedAt });
    this.publish();

    const result = await runTurn(
      this.daemon,
      conversationId,
      buildPayload({
        you: me.handle,
        speakingWith: other,
        purpose,
        transcript,
        ...(steer !== undefined ? { steer } : {}),
        ...(notice !== undefined ? { notice } : {}),
      }),
    );

    const took = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

    switch (result.kind) {
      case "said": {
        daemonLog.info("answered", {
          took,
          cost: result.cost.costUSD !== undefined ? `$${result.cost.costUSD.toFixed(4)}` : "unpriced",
          chars: result.text.length,
        });
        // The ledger is written when the hub confirms this message, not here — see
        // `recordOutgoing`. The steer is parked so that confirmation can say what prompted it.
        if (steer !== undefined) this.pendingSteer.set(conversationId, steer);
        this.activity.set(conversationId, { state: "idle" });
        if (result.closing) daemonLog.info("closing the conversation");
        this.send({
          t: "say",
          conversationId,
          text: result.text,
          ...(result.closing ? { closing: true } : {}),
          ...(result.cost.costUSD !== undefined ? { costUSD: result.cost.costUSD } : {}),
          ...(result.cost.incomplete ? { costIncomplete: true } : {}),
        });
        this.publish();
        return;
      }

      case "passed":
        daemonLog.info("passed", { took });
        this.activity.set(conversationId, { state: "idle" });
        this.send({
          t: "pass",
          conversationId,
          ...(result.cost.costUSD !== undefined ? { costUSD: result.cost.costUSD } : {}),
          ...(result.cost.incomplete ? { costIncomplete: true } : {}),
        });
        this.publish();
        return;

      case "needs-you":
        daemonLog.warn("waiting for you to approve a tool", { run: result.runId, took });
        // Deliberately told to the other side too. A conversation that stops because someone's
        // agent is waiting for approval should say so, rather than just going quiet.
        this.activity.set(conversationId, { state: "needs-you", runId: result.runId });
        this.send({
          t: "trouble",
          conversationId,
          reason: `${me.handle} is waiting on their operator to approve a tool`,
        });
        this.publish();
        return;

      case "failed":
        daemonLog.error(result.reason, { took });
        this.activity.set(conversationId, { state: "idle" });
        this.send({ t: "trouble", conversationId, reason: result.reason });
        this.publish();
        return;

      default:
        return;
    }
  }
}
