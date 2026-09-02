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
  WELCOME_TRANSCRIPT_WINDOW,
  type ClientFrame,
  type Connection,
  type Conversation,
  type DirectoryEntry,
  type Invite,
  type Message,
  type Agent,
  type PeerPresence,
} from "@quartet/protocol";
import type { DaemonSettings } from "./config";
import { answerParkedRun, runTurn, type HumanQuestion, type TurnResult } from "./jazz";
import {
  missingOutgoing,
  readAsides,
  readLedger,
  recordAside,
  recordSent,
  type LedgerEntry,
} from "./ledger";
import { logger } from "./log";
import { buildPayload } from "./prompt";

/** What your own agent is doing right now, per conversation. Drives the UI's live states. */
export type Activity =
  | { readonly state: "idle" }
  | { readonly state: "thinking"; readonly since: number }
  | {
      readonly state: "needs-you";
      readonly runId: string;
      readonly pending:
        | { readonly kind: "approval"; readonly message?: string }
        | { readonly kind: "question"; readonly question: HumanQuestion };
    };

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
  /** Whether the oldest message held for a room really is the room's first. */
  readonly atStart: Record<string, boolean>;
  readonly asides: Record<string, Aside[]>;
  readonly activity: Record<string, Activity>;
  readonly presence: Record<string, PeerPresence>;
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
  private readonly atStart = new Map<string, boolean>();
  private readonly asides = new Map<string, Aside[]>();
  private readonly activity = new Map<string, Activity>();
  private readonly presence = new Map<string, PeerPresence>();
  private ledger: LedgerEntry[] = [];
  private lastError: string | undefined;
  /**
   * What the owner asked for, per conversation, until the resulting message comes back.
   *
   * Held here rather than passed through the send because the ledger is written when the hub
   * confirms, by which point the turn that produced it is long over.
   */
  private readonly pendingSteer = new Map<string, string>();
  /** Frames that arrived while the socket was down. Flushed after welcome, after hello. */
  private readonly outbound: ClientFrame[] = [];

  constructor(
    private readonly hubUrl: string,
    private readonly agentToken: string,
    private readonly daemon: DaemonSettings,
  ) {}

  async start(): Promise<void> {
    this.ledger = await readLedger();
    for (const aside of await readAsides()) {
      this.asides.set(aside.conversationId, [
        ...(this.asides.get(aside.conversationId) ?? []),
        aside,
      ]);
    }
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
      atStart: Object.fromEntries(this.atStart),
      asides: Object.fromEntries(this.asides),
      activity: Object.fromEntries(this.activity),
      presence: Object.fromEntries(this.presence),
      ledger: this.ledger,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  private publish(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }

  /** Send a frame to the hub. Queued while offline and flushed after the next welcome. */
  send(frame: ClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return;
    }
    this.outbound.push(frame);
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
    void recordAside(aside).then((error) => {
      if (error !== undefined) {
        this.lastError = `your instruction was shown but not saved: ${error}`;
        this.publish();
      }
    });
    this.send({ t: "nudge", conversationId, steer: text });
  }

  /**
   * Ask the hub for the page of messages before the oldest one held for a room.
   *
   * A no-op once the start is reached, so a browser that keeps asking cannot make the hub
   * keep answering.
   */
  requestHistory(conversationId: string): void {
    if (this.atStart.get(conversationId) === true) return;
    const oldest = this.messages.get(conversationId)?.[0];
    if (oldest === undefined) return;
    this.send({ t: "history.load", conversationId, beforeId: oldest.id });
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
      if (this.socket !== socket) return;
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
        this.presence.clear();
        this.messages.clear();
        this.atStart.clear();
        for (const message of frame.messages) {
          const list = this.messages.get(message.conversationId) ?? [];
          if (!list.some((existing) => existing.id === message.id)) {
            this.messages.set(message.conversationId, [...list, message]);
          }
        }
        // Welcome carries a window, not a whole history. A room that came back short of
        // that window has nothing older; anything else has to be asked about. Guessing
        // wrong here costs one empty page, which corrects itself.
        for (const conversation of frame.conversations) {
          const held = this.messages.get(conversation.id)?.length ?? 0;
          this.atStart.set(conversation.id, held < WELCOME_TRANSCRIPT_WINDOW);
        }
        await this.catchUpLedger(frame.messages);
        this.flushOutbound();
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
          room: frame.state !== "live" ? frame.state : undefined,
        });
        this.conversations = this.conversations.map((conversation) =>
          conversation.id === frame.conversationId
            ? {
                ...conversation,
                budgetRemaining: frame.remaining,
                limit: frame.limit,
                spentUSD: frame.spentUSD,
                spendIncomplete: frame.spendIncomplete,
                state: frame.state,
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

      case "presence":
        this.presence.set(frame.conversationId, frame.other);
        this.publish();
        return;

      case "history": {
        // Prepended, and deduped against what is already held: a page that overlaps the
        // window welcome carried must not double every message in the room.
        const held = this.messages.get(frame.conversationId) ?? [];
        const known = new Set(held.map((message) => message.id));
        const older = frame.messages.filter((message) => !known.has(message.id));
        this.messages.set(frame.conversationId, [...older, ...held]);
        this.atStart.set(frame.conversationId, frame.reachedStart);
        this.publish();
        return;
      }

      case "error":
        hubLog.error(frame.detail);
        this.lastError = frame.detail;
        this.publish();
        return;

      default:
        return;
    }
  }

  private flushOutbound(): void {
    const queued = this.outbound.splice(0);
    for (const frame of queued) this.send(frame);
  }

  /** Any confirmed line of ours the file missed — crash between hub ack and disk. */
  private async catchUpLedger(messages: readonly Message[]): Promise<void> {
    const me = this.me?.handle;
    if (me === undefined) return;
    const known = new Set(this.ledger.map((entry) => entry.id));
    for (const message of missingOutgoing(messages, me, known)) {
      await this.recordOutgoing(message);
    }
  }

  /**
   * Write one confirmed outgoing message into the local record.
   *
   * Driven by the hub's confirmation rather than by our own send. Welcome catch-up uses
   * the same path so a crash between confirm and disk does not leave a permanent hole.
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
    const error = await recordSent(entry);
    if (error !== undefined) {
      this.lastError = `the room has this line; the local record could not save it: ${error}`;
      log.error("ledger write failed", { id: entry.id, error });
    }
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
    if (this.activity.get(conversationId)?.state === "thinking") return;

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

    this.finishTurn(conversationId, result, startedAt, steer);
  }

  /**
   * Approve or decline a parked jazz tool from this app, then finish the turn.
   */
  async resolveApproval(
    conversationId: string,
    runId: string,
    approved: boolean,
    note?: string,
    questionResponse?: string,
  ): Promise<void> {
    const startedAt = Date.now();
    this.activity.set(conversationId, { state: "thinking", since: startedAt });
    this.publish();
    const result = await answerParkedRun(this.daemon, runId, approved, note, questionResponse);
    this.finishTurn(conversationId, result, startedAt, this.pendingSteer.get(conversationId));
  }

  private finishTurn(
    conversationId: string,
    result: TurnResult,
    startedAt: number,
    steer: string | undefined,
  ): void {
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
        this.activity.set(conversationId, {
          state: "needs-you",
          runId: result.runId,
          pending: result.pending,
        });
        this.send({ t: "waiting", conversationId });
        this.publish();
        return;

      case "failed":
        daemonLog.error(result.reason, { took });
        this.activity.set(conversationId, { state: "idle" });
        this.send({
          t: "trouble",
          conversationId,
          reason: result.reason,
        });
        this.publish();
        return;

      default:
        return;
    }
  }
}
