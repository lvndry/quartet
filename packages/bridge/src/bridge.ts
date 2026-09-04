/**
 * @fileoverview The bridge: your half of quartet, running on your machine.
 *
 * One outbound socket to the hub, jazz over loopback, and the app's backend. State is
 * mirrored rather than queried: the hub pushes, this keeps a copy, the browser gets the whole
 * snapshot on every change. `docs/design.md` §1 says why all three of those are deliberate.
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
  type Aside,
  type BridgeState,
  type Limit,
  type PeerPresence,
  type Activity,
} from "@quartet/protocol";
import { fingerprint, parseTag } from "@quartet/identity";
import type { DaemonSettings } from "./config";
import type { Attestor, Verdict } from "./attest";
import type { Sealer } from "./sealer";
import type { JazzRoster } from "./agent-admin";
import { describeModel } from "./jazz-agents";
import { KnownKeys } from "./known";
import {
  answerParkedRun,
  createIdleWatchdog,
  MAX_PAYLOAD_BYTES,
  runTurn,
  TURN_TIMEOUT_MS,
  type TurnResult,
} from "./jazz";
import {
  missingOutgoing,
  readAsides,
  readLedger,
  recordAside,
  recordSent,
  type LedgerEntry,
} from "./ledger";
import { logger } from "./log";
import { composeTurnPayload } from "./prompt";
import {
  recordToolCall,
  type DaemonProgressEvent,
  type ToolCall,
} from "./tool-log";

// The app's view of this process, defined once in the protocol package. They used to be
// declared here and declared again by hand in the web client, with nothing that would have
// failed if the two had drifted.
export type { Activity, Aside, BridgeState, ToolCall } from "@quartet/protocol";

const log = logger("bridge");
const hubLog = logger("hub");
const daemonLog = logger("daemon");

/** Comfortably inside the hub's deadline, so one dropped beat is survivable. */
const PROGRESS_EVERY_MS = 45_000;

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
  private readonly toolCalls = new Map<string, readonly ToolCall[]>();
  private readonly presence = new Map<string, PeerPresence[]>();
  private ledger: LedgerEntry[] = [];
  private lastError: string | undefined;
  /**
   * What the owner asked for, until the resulting message comes back.
   *
   * The ledger is written when the hub confirms, by which point the turn is long over.
   */
  private readonly pendingSteer = new Map<string, string>();
  /** Frames that arrived while the socket was down. Flushed after welcome, after hello. */
  private readonly outbound: ClientFrame[] = [];
  /** Heartbeat timers for turns currently running, one per conversation. */
  private readonly beating = new Map<string, ReturnType<typeof setInterval>>();
  /**
   * One-time secrets that let this machine's daemon report into a running turn.
   *
   * Anything on this machine can reach the loopback port, and "your agent is reading your
   * calendar" is not a sentence somebody else should be able to put in the room.
   */
  private readonly progressKeys = new Map<string, string>();
  /**
   * The idle watchdog's `poke`, per conversation with a turn in flight.
   *
   * `onDaemonProgress` and `takeTurn` share a conversation id but not a call stack.
   */
  private readonly watchdogPokes = new Map<string, () => void>();
  /**
   * The hub's name for the turn currently running, per conversation.
   *
   * Everything a turn produces has to name it. Held here because the heartbeat timer and the
   * daemon's progress callback both need it and neither shares a stack with the turn.
   */
  private readonly dispatches = new Map<string, string>();

  private readonly verdicts = new Map<string, Verdict>();


  constructor(
    private readonly hubUrl: string,
    private readonly daemon: DaemonSettings,
    private readonly attestor: Attestor,
    private readonly sealer: Sealer,
    private readonly known: KnownKeys = new KnownKeys(),
  ) {}

  /** `AgentAdmin` owns the roster; this holds the copy the snapshot is built from. */
  setJazzRoster(roster: JazzRoster): void {
    this.jazzRoster = roster;
    this.publish();
  }

  private jazzRoster: JazzRoster = { agents: [] };

  private currentModel(): string | undefined {
    const mine = this.jazzRoster.agents.find((agent) => agent.id === this.jazzRoster.myAgentId);
    return mine === undefined ? undefined : describeModel(mine);
  }

  async start(): Promise<void> {
    await this.attestor.ready();
    await this.known.load();
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
    for (const conversationId of [...this.beating.keys()]) this.stopBeating(conversationId);
    this.socket?.close();
  }

  subscribe(listener: (state: BridgeState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): BridgeState {
    const keyStoreProblem = this.known.problem();
    const myModel = this.currentModel();
    return {
      connectedToHub: this.connectedToHub,
      ...(this.me !== undefined ? { me: this.me } : {}),
      ...(myModel !== undefined ? { myModel } : {}),
      jazzAgents: this.jazzRoster.agents,
      ...(this.jazzRoster.myAgentId !== undefined
        ? { myAgentId: this.jazzRoster.myAgentId }
        : {}),
      ...(this.jazzRoster.problem !== undefined ? { jazzProblem: this.jazzRoster.problem } : {}),
      ...(this.jazzRoster.catalog !== undefined ? { jazzCatalog: this.jazzRoster.catalog } : {}),
      connections: this.connections,
      conversations: this.conversations,
      invites: this.invites,
      directory: this.directory,
      messages: Object.fromEntries(this.messages),
      atStart: Object.fromEntries(this.atStart),
      asides: Object.fromEntries(this.asides),
      activity: Object.fromEntries(this.activity),
      toolCalls: Object.fromEntries(this.toolCalls),
      presence: Object.fromEntries(this.presence),
      ledger: this.ledger,
      verdicts: Object.fromEntries(this.verdicts),
      keyConflicts: this.known.all(),
      fingerprints: this.fingerprints(),
      ...(keyStoreProblem !== undefined ? { keyStoreProblem } : {}),
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
    // Sealed before anything else happens, because a steer that cannot be sealed must not be
    // sent in the clear as a fallback — the whole reason this is sealed is that the hub has
    // no business holding a person's instructions to their own agent.
    const sealed = this.sealer.toSelf(text, conversationId);
    if (sealed === undefined) {
      this.lastError = "could not seal your instruction, so it was not sent";
      log.error("sealing a steer failed", { conversation: conversationId });
      this.publish();
      return;
    }

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
    this.send({ t: "nudge", conversationId, steer: sealed });
  }

  /** Short forms for every key on screen: mine, the directory's, and both sides of a conflict. */
  private fingerprints(): Record<string, string> {
    const dids = [
      this.attestor.did,
      ...this.directory.flatMap((entry) => (entry.agent.did !== undefined ? [entry.agent.did] : [])),
      ...this.connections.flatMap((entry) =>
        entry.withAgent.did !== undefined ? [entry.withAgent.did] : [],
      ),
      ...this.known.all().flatMap((conflict) => [conflict.pinned, conflict.offered]),
    ];
    const out: Record<string, string> = {};
    for (const did of dids) {
      const short = fingerprint(did);
      if (short !== undefined) out[did] = short;
    }
    return out;
  }

  /**
   * The key a handle is known by here, from whatever the hub has shown us about them.
   *
   * Undefined for a stranger, which is the honest answer: until somebody compares a
   * fingerprint out of band, "the key the hub says is theirs" is all any of this can mean.
   * What it does buy immediately is *continuity* — the hub cannot change the key behind a
   * handle later without every line after it failing to verify.
   */
  private didFor(handle: string): string | undefined {
    if (handle === this.me?.handle) return this.attestor.did;
    // The pin wins over whatever the hub is saying now. That is the entire point of holding
    // one: a directory entry is the hub's claim, and a pin is what this machine concluded
    // the first time — possibly after somebody read the fingerprint out loud.
    return this.known.did(handle);
  }

  /**
   * Feed every key the hub has mentioned through the pin file.
   *
   * Run on each directory and connection update rather than only at first contact, because a
   * hub that wanted to swap a key would naturally do it between sessions, when nobody is
   * looking at the screen it would appear on.
   */
  private pinKnownKeys(): void {
    const seen: { handle: string; did: string | undefined }[] = [
      ...this.directory.map((entry) => ({
        handle: entry.agent.handle,
        did: entry.agent.did,
      })),
      ...this.connections.map((entry) => ({
        handle: entry.withAgent.handle,
        did: entry.withAgent.did,
      })),
    ];
    for (const { handle, did } of seen) {
      if (did === undefined || handle === this.me?.handle) continue;
      const conflict = this.known.offer(handle, did);
      if (conflict !== undefined) {
        hubLog.error(
          `@${handle} is being offered under a different key than the one pinned here. ` +
            "Nothing from them will verify until you compare fingerprints and decide.",
        );
      }
    }
  }

  /** Judge one message and remember the verdict for the app. */
  private judge(message: Message, replay = false): Verdict {
    const verdict = this.attestor.check(
      message,
      { expectedDid: this.didFor(message.authorHandle) },
      { replay },
    );
    this.verdicts.set(message.id, verdict);
    if (verdict.state === "broken") {
      hubLog.error(`a message from @${message.authorHandle} did not check out: ${verdict.why}`);
    }
    return verdict;
  }

  /**
   * Invite somebody, by handle or by the fuller form somebody hands out: `@mira#4f2a-…`.
   *
   * When a fingerprint is given it is checked against the key the hub is offering, and a
   * mismatch stops the invite rather than warning about it. This is the one moment where a
   * person has independent knowledge of who they mean — they were told out of band — so it is
   * the one moment where refusing beats proceeding and explaining afterwards.
   *
   * A bare handle goes through, and the key gets pinned on first sight like any other. That
   * is weaker, and it is the user's call to make rather than this function's.
   */
  invite(target: string, purpose: string, limit?: Limit): { error: string } | undefined {
    const parsed = parseTag(target);
    if (parsed === undefined) {
      return { error: `"${target}" is not a handle or a handle#fingerprint` };
    }

    const offered = this.directory.find((entry) => entry.agent.handle === parsed.handle)?.agent.did;
    if (parsed.fingerprint !== undefined) {
      if (offered === undefined) {
        return {
          error: `this hub has no key for @${parsed.handle}, so the fingerprint proves nothing`,
        };
      }
      if (fingerprint(offered) !== parsed.fingerprint) {
        return {
          error:
            `@${parsed.handle} on this hub has fingerprint ${fingerprint(offered) ?? "none"}, ` +
            `not ${parsed.fingerprint}. Do not send this until you know why.`,
        };
      }
      // Checked by a person, so it supersedes anything pinned on a hub's say-so alone.
      void this.known.repin(parsed.handle, offered);
    }

    this.send({
      t: "invite.send",
      toHandle: parsed.handle,
      purpose,
      ...(limit !== undefined ? { limit } : {}),
    });
    return undefined;
  }

  /** Accept a handle's new key, after a person has looked at the fingerprints and decided. */
  async trustNewKey(handle: string): Promise<void> {
    const conflict = this.known.conflict(handle);
    if (conflict === undefined) return;
    await this.known.repin(handle, conflict.offered);
    hubLog.info(`re-pinned @${handle} to its new key`);
    this.publish();
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
      // Nothing is said until the hub asks. The introduction is a signature over the
      // challenge it is about to send, so there is no secret to present and none to steal.
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
      // Not on a deliberate shutdown: that is not a failure, and the app is about to close
      // anyway. Cleared automatically the moment `open` succeeds again.
      if (!this.closing) this.lastError = `can't reach the hub at ${this.hubUrl} — retrying`;
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
        this.attestor.startWindow();
        // Keys first: judging a transcript before knowing which key each handle signs with
        // would mark a room full of perfectly good lines as coming from strangers.
        this.pinKnownKeys();
        for (const message of frame.messages) {
          const list = this.messages.get(message.conversationId) ?? [];
          if (!list.some((existing) => existing.id === message.id)) {
            this.messages.set(message.conversationId, [...list, message]);
          }
          // A replayed transcript is checked like anything else — taking it on trust would
          // make reconnecting the way to launder a line that could not survive being checked
          // when it was new. Its chain is read against the window rather than against where
          // the live conversation had got to; see Attestor.startWindow.
          this.judge(message, true);
        }
        // Welcome carries a window, not a whole history. A room that came back short of
        // that window has nothing older; anything else has to be asked about. Guessing
        // wrong here costs one empty page, which corrects itself.
        for (const conversation of frame.conversations) {
          const held = this.messages.get(conversation.id)?.length ?? 0;
          this.atStart.set(conversation.id, held < WELCOME_TRANSCRIPT_WINDOW);
        }
        // The window ends at the newest line, so it becomes the running position.
        this.attestor.settleWindow();
        await this.catchUpLedger(frame.messages);
        this.flushOutbound();
        this.publish();
        return;

      case "challenge":
        this.send({
          t: "hello",
          did: this.attestor.did,
          challenge: frame.nonce,
          signature: this.attestor.answer(frame.nonce),
        });
        return;

      case "directory":
        this.directory = frame.people;
        this.pinKnownKeys();
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
        this.pinKnownKeys();
        this.publish();
        return;

      case "conversation":
        this.conversations = [
          frame.conversation,
          ...this.conversations.filter((c) => c.id !== frame.conversation.id),
        ];
        this.publish();
        return;

      case "conversation.removed":
        this.conversations = this.conversations.filter((c) => c.id !== frame.conversationId);
        this.messages.delete(frame.conversationId);
        this.presence.delete(frame.conversationId);
        this.activity.delete(frame.conversationId);
        this.toolCalls.delete(frame.conversationId);
        this.atStart.delete(frame.conversationId);
        this.publish();
        return;

      case "appended": {
        const list = this.messages.get(frame.message.conversationId) ?? [];
        if (!list.some((message) => message.id === frame.message.id)) {
          this.messages.set(frame.message.conversationId, [...list, frame.message]);
        }
        this.judge(frame.message);
        // Our own message landing means our turn is over; anything else leaves us as we were.
        if (frame.message.authorHandle === this.me?.handle) {
          this.attestor.confirmOwn(frame.message);
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
                bowedOut: frame.bowedOut,
              }
            : conversation,
        );
        this.publish();
        return;

      case "turn":
        await this.takeTurn(
          frame.conversationId,
          frame.dispatch,
          frame.purpose,
          frame.transcript,
          frame.earlier,
          this.openSteer(frame.conversationId, frame.steer),
          frame.notice,
        );
        return;

      case "presence":
        this.presence.set(frame.conversationId, frame.others);
        this.publish();
        return;

      case "history": {
        // Deduped against what is held: a page overlapping welcome's window must not double
        // every message in the room.
        const held = this.messages.get(frame.conversationId) ?? [];
        const known = new Set(held.map((message) => message.id));
        const older = frame.messages.filter((message) => !known.has(message.id));
        // Checked like everything else, judged against itself, and not settled: these are
        // older than the running position and must not move it backwards.
        this.attestor.startWindow();
        for (const message of frame.messages) this.judge(message, true);
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
   * The steer the hub handed back, in the words the person actually typed.
   *
   * A steer that will not open still lets the turn run, unsteered. The alternative is
   * refusing a turn the hub has already charged for and armed a deadline on, which strands
   * the room over a failure the other party had no part in — so the turn goes ahead and the
   * app says what was lost. The one thing not on offer is proceeding quietly: a person whose
   * instruction vanished will read the answer as their agent ignoring them.
   */
  private openSteer(conversationId: string, sealed: string | undefined): string | undefined {
    if (sealed === undefined) return undefined;

    const opened = this.sealer.open(sealed, conversationId);
    if (opened.state === "opened") return opened.text;

    this.lastError =
      "your last instruction could not be unsealed, so this turn ran without it — the room is unaffected";
    log.error("a steer did not open", { conversation: conversationId, why: opened.state });
    this.publish();
    return undefined;
  }

  /**
   * Answer one dispatched turn by waking the local jazz agent.
   *
   * The thread key is the conversation id, so jazz resumes that conversation and nothing
   * else: two threads with the same person stay two separate memories.
   */
  private async takeTurn(
    conversationId: string,
    dispatch: string,
    purpose: string,
    transcript: readonly Message[],
    earlier: number,
    steer: string | undefined,
    notice: string | undefined,
  ): Promise<void> {
    const me = this.me;
    if (me === undefined) return;
    if (this.activity.get(conversationId)?.state === "thinking") return;

    const conversation = this.conversations.find((candidate) => candidate.id === conversationId);
    const room = conversation?.participants.filter((handle) => handle !== me.handle) ?? [];

    const startedAt = Date.now();
    daemonLog.info(`turn in a room with ${room.map((handle) => `@${handle}`).join(", ") || "nobody"}`, {
      conversation: conversationId,
      steered: steer !== undefined ? "yes" : undefined,
    });
    // Held for the whole turn, including across an approval the owner has to answer.
    this.dispatches.set(conversationId, dispatch);
    this.activity.set(conversationId, { state: "thinking", since: startedAt });
    // One turn, one log. What the last turn did is answered by the message it produced.
    this.toolCalls.delete(conversationId);
    this.publish();
    this.startBeating(conversationId, dispatch);

    // Trimmed to what this machine's daemon will accept, and reported rather than silently
    // lost: a size ceiling on one request is not a ceiling on the conversation.
    const composed = composeTurnPayload(
      {
        you: me.handle,
        speakingWith: room,
        purpose,
        transcript,
        earlier,
        ...(steer !== undefined ? { steer } : {}),
        ...(notice !== undefined ? { notice } : {}),
      },
      MAX_PAYLOAD_BYTES,
    );
    if (composed.dropped > 0 || composed.truncated > 0) {
      daemonLog.warn("trimmed the turn to fit the daemon's body limit", {
        dropped: composed.dropped > 0 ? composed.dropped : undefined,
        truncated: composed.truncated > 0 ? composed.truncated : undefined,
      });
    }

    const progressKey = crypto.randomUUID().replaceAll("-", "");
    this.progressKeys.set(progressKey, conversationId);
    const progressUrl =
      this.localOrigin === undefined
        ? undefined
        : `${this.localOrigin}/progress/${progressKey}`;

    const watchdog = createIdleWatchdog(TURN_TIMEOUT_MS);
    this.watchdogPokes.set(conversationId, watchdog.poke);

    const result = await runTurn(
      this.daemon,
      conversationId,
      composed.payload,
      watchdog,
      progressUrl,
    );
    this.progressKeys.delete(progressKey);
    this.watchdogPokes.delete(conversationId);
    watchdog.dispose();

    this.finishTurn(conversationId, dispatch, result, startedAt, steer);
  }

  /**
   * Approve or decline a parked jazz tool from this app, then finish the turn.
   *
   * The *same* turn, so it answers under the dispatch that turn was given — a parked run is
   * the one case where a person's deliberation sits in the middle of a dispatch.
   */
  async resolveApproval(
    conversationId: string,
    runId: string,
    approved: boolean,
    note?: string,
    questionResponse?: string,
  ): Promise<void> {
    const dispatch = this.dispatches.get(conversationId);
    if (dispatch === undefined) {
      log.error("no turn is waiting on you in that conversation", { conversation: conversationId });
      return;
    }
    const startedAt = Date.now();
    this.activity.set(conversationId, { state: "thinking", since: startedAt });
    this.publish();
    const result = await answerParkedRun(this.daemon, runId, approved, note, questionResponse);
    this.finishTurn(conversationId, dispatch, result, startedAt, this.pendingSteer.get(conversationId));
  }

  /**
   * Tell the hub, on a timer, that this turn is still running.
   *
   * The hub cannot see a model thinking; all it has is silence. See `docs/design.md` §4.
   */
  private startBeating(conversationId: string, dispatch: string): void {
    this.stopBeating(conversationId);
    this.beating.set(
      conversationId,
      setInterval(() => {
        if (this.activity.get(conversationId)?.state === "idle") {
          this.stopBeating(conversationId);
          return;
        }
        this.send({ t: "progress", conversationId, dispatch });
      }, PROGRESS_EVERY_MS),
    );
  }

  /**
   * Where this bridge is reachable, once its own server is listening.
   *
   * Set by the local server rather than assumed: the port is whatever was free.
   */
  private localOrigin: string | undefined;

  setLocalOrigin(origin: string): void {
    this.localOrigin = origin;
  }

  /**
   * The daemon reporting what a turn is doing.
   *
   * Returns whether the key was live, so the caller refuses an unknown one rather than
   * accepting anything that arrives on the port.
   */
  onDaemonProgress(key: string, event: DaemonProgressEvent): boolean {
    const conversationId = this.progressKeys.get(key);
    if (conversationId === undefined) {
      // Worth a line rather than a silent `false`: this is how a turn ends up looking idle
      // while the daemon is busy. The key itself is deliberately not logged — it is the
      // one-time secret that authorises reporting into a live turn, and a bearer value does
      // not belong in a log at any level. The count separates a stale report from one for a
      // turn nobody started.
      daemonLog.debug("progress for an unknown key, ignored", { live: this.progressKeys.size });
      return false;
    }

    // The daemon just proved it is still alive — push the idle deadline back out. Done
    // before the activity check, because a run parked on an approval is still a live run.
    this.watchdogPokes.get(conversationId)?.();
    daemonLog.debug("progress", {
      kind: typeof event.kind === "string" ? event.kind : "unknown",
      tool: typeof event.toolName === "string" ? event.toolName : undefined,
    });

    const tool = typeof event.toolName === "string" ? event.toolName : undefined;
    if (tool === undefined) return true;
    this.toolCalls.set(
      conversationId,
      recordToolCall(this.toolCalls.get(conversationId) ?? [], event),
    );

    const running = this.activity.get(conversationId);
    if (running?.state !== "thinking") {
      this.publish();
      return true;
    }

    const doing =
      event.kind === "approval-required"
        ? `waiting for you to approve ${tool}`
        : event.kind === "tool-started"
          ? tool
          : undefined;
    // A finished tool leaves the note as it was rather than blanking it: the next thing is
    // usually the model thinking again, and flicking to nothing reads as a stall. The log
    // has the result either way, so holding the line loses nothing.
    this.activity.set(conversationId, doing === undefined ? running : { ...running, doing });
    this.publish();
    if (doing === undefined) return true;
    // The other side gets the name, on the heartbeat that already re-arms the deadline.
    // Only the name: `event.result` is output from this machine, and a room is not the place
    // for it. See `ToolCall`. Named with the dispatch, like everything else a turn produces.
    const dispatch = this.dispatches.get(conversationId);
    if (dispatch !== undefined) this.send({ t: "progress", conversationId, dispatch, note: doing });
    return true;
  }

  private stopBeating(conversationId: string): void {
    const timer = this.beating.get(conversationId);
    if (timer === undefined) return;
    clearInterval(timer);
    this.beating.delete(conversationId);
  }

  private finishTurn(
    conversationId: string,
    dispatch: string,
    result: TurnResult,
    startedAt: number,
    steer: string | undefined,
  ): void {
    const took = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    // A parked run is the only outcome still going, and it has the hub's longer approval
    // deadline rather than this heartbeat.
    this.stopBeating(conversationId);

    switch (result.kind) {
      case "said": {
        daemonLog.info("answered", {
          took,
          cost: result.cost.costUSD !== undefined ? `$${result.cost.costUSD.toFixed(4)}` : "unpriced",
          chars: result.text.length,
        });
        // The ledger is written when the hub confirms — see `recordOutgoing`. The steer is
        // parked so that confirmation can say what prompted it.
        if (steer !== undefined) this.pendingSteer.set(conversationId, steer);
        this.activity.set(conversationId, { state: "idle" });
        if (result.closing) daemonLog.info("closing the conversation");
        this.dispatches.delete(conversationId);
        this.send({
          t: "say",
          conversationId,
          dispatch,
          text: result.text,
          authorship: this.attestor.speak(conversationId, "agent", dispatch, result.text),
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
        this.dispatches.delete(conversationId);
        this.send({
          t: "pass",
          conversationId,
          dispatch,
          authorship: this.attestor.speak(conversationId, "pass", dispatch, ""),
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
        this.send({ t: "waiting", conversationId, dispatch });
        this.publish();
        return;

      case "failed":
        daemonLog.error(result.reason, { took });
        this.activity.set(conversationId, { state: "idle" });
        this.dispatches.delete(conversationId);
        this.send({
          t: "trouble",
          conversationId,
          dispatch,
          reason: result.reason,
        });
        this.publish();
        return;

      default:
        return;
    }
  }
}
