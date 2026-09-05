/**
 * @fileoverview The bridge: your half of quartet, running on your machine.
 *
 * One outbound socket to the hub, jazz over loopback, and the app's backend. State is
 * mirrored rather than queried: the hub pushes, this keeps a copy, the browser gets the whole
 * snapshot on every change. `docs/design/architecture.md` says why all three of those are deliberate.
 */

import {
  MAX_MESSAGE_LENGTH,
  parseServerFrame,
  REFUSED_CLOSE_CODE,
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
  type Opened,
  type SealingClaim,
  type HubRefusal,
  type RefusalReason,
} from "@quartet/protocol";
import { displayTag, fingerprint, parseTag, tag } from "@quartet/identity";
import type { DaemonSettings } from "./config";
import type { Attestor, Verdict } from "./attest";
import { recipientsFor, withWords, type Sealer } from "./sealer";
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
import { checkHub, describeHub, explainHub, summariseHub } from "./hub-check";
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

/**
 * What to do about a refusal, as opposed to what it was.
 *
 * One sentence each, naming a command where there is one. These are read by somebody whose
 * agent has just stopped working, so the useful half is the instruction, not the diagnosis.
 */
function remedyFor(reason: RefusalReason, hubUrl: string): string {
  switch (reason) {
    case "unclaimed-key":
      return `this key has no handle on ${hubUrl} — run \`quartet connect\` to claim one there`;
    case "bad-sealing-key":
      return "this bridge's sealing key is not signed by its own identity key — sealing.json and identity.json have come from different identities";
    case "bad-signature":
      return "the hub would not accept this key's signature — identity.json may be damaged";
    default:
      // Nothing a person does differently fixes a challenge mismatch: it is this end and the
      // hub disagreeing about a nonce, which is a bug or a proxy replaying frames.
      return "the handshake did not match the challenge this hub sent — report this, it is not a setting";
  }
}

/**
 * Read a close reason back as a refusal, defaulting rather than trusting.
 *
 * The string arrives over the wire from the hub, so an unknown value is version skew or
 * something in the middle rewriting frames. Either way the useful response is to stop, which
 * every reason here does.
 */
function asRefusalReason(text: string): RefusalReason {
  const known: readonly RefusalReason[] = [
    "unclaimed-key",
    "bad-challenge",
    "bad-signature",
    "bad-sealing-key",
  ];
  return known.find((reason) => reason === text) ?? "bad-challenge";
}

/** Comfortably inside the hub's deadline, so one dropped beat is survivable. */
const PROGRESS_EVERY_MS = 45_000;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * How often to tell the hub this socket is still wanted.
 *
 * Between turns a quartet socket carries nothing, and everything in the path treats a silent
 * connection as an abandoned one — the hub's own idle timeout first, then whatever tunnel or
 * NAT table sits in between. `PROGRESS_EVERY_MS` does not cover this: it beats only while a
 * turn is running, which was never the case at risk.
 */
const KEEPALIVE_EVERY_MS = 30_000;

/**
 * How long the hub may say nothing at all before this end stops believing in the socket.
 *
 * Three missed pongs. A socket that can still be written to but never answers is exactly what
 * a dropped tunnel leaves behind: the bridge sees an open connection, the hub has no such
 * connection, and nothing resolves it until something is expected back and does not arrive.
 */
const SILENCE_LIMIT_MS = KEEPALIVE_EVERY_MS * 3;

/**
 * How long to wait for a socket that never finishes connecting.
 *
 * A tunnel that has stopped routing does not refuse the connection, it swallows it, and the
 * handshake then sits there until the OS gives up — which took a quarter of an hour and
 * looked, in the log, like nothing happening at all.
 */
const CONNECT_TIMEOUT_MS = 15_000;

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
   * Set once the hub has refused this bridge at the handshake, and never cleared by retrying.
   *
   * Its presence is what stops the reconnect loop. Every refusal is settled — the same key
   * saying the same thing gets the same answer — so a bridge that keeps knocking is not
   * being resilient, it is filling a log with a question that has already been answered.
   */
  private refusal: HubRefusal | undefined;
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
  /** The keepalive for the current socket. One at a time, cleared with the socket it belongs to. */
  private keepalive?: ReturnType<typeof setInterval>;
  /** When the hub last said anything. Any frame counts, not just a pong. */
  private lastHeard = 0;
  /**
   * Whether this run of failures has already been explained.
   *
   * Once per outage, not once per attempt: the reconnect loop is deliberately patient, and a
   * patient loop that repeats its diagnosis every thirty seconds is just noise with a reason.
   */
  private diagnosed = false;
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

  /**
   * What each sealed line said, by message id.
   *
   * Beside the transcript rather than inside it, like the verdicts. `messages` holds what the
   * hub relayed, which is what the author signed; this holds what this machine's keys made of
   * it. Merging them would put a signature next to text it does not cover.
   */
  private readonly opened = new Map<string, Opened>();

  /**
   * This agent's sealing key, signed by its identity key.
   *
   * Made once per run rather than per handshake. The signature covers the moment it was made,
   * so re-signing on every reconnect would churn a value the far side has no reason to see
   * change — and a claim that changes for no reason is one nobody can learn to read.
   */
  private sealingClaim?: SealingClaim;

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
    // After `ready`, because the identity key is what signs it.
    this.sealingClaim = this.attestor.bindSealingKey(this.sealer.sealingDid);
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
    this.stopKeepalive();
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
      opened: Object.fromEntries(this.opened),
      keyConflicts: this.known.all(),
      labels: this.labels(),
      fingerprints: this.fingerprints(),
      ...(keyStoreProblem !== undefined ? { keyStoreProblem } : {}),
      ...(this.refusal !== undefined ? { hubRefusal: this.refusal } : {}),
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

  /**
   * Every key this bridge can put a name to, paired with the full tag for that name.
   *
   * One place, so a room, the directory and a log line cannot disagree about who somebody is.
   */
  private taggedNames(): Map<string, string> {
    const pairs = new Map<string, string>();
    const note = (handle: string, did: string | undefined): void => {
      if (did === undefined) return;
      const named = tag(handle, did);
      if (named !== undefined) pairs.set(did, named);
    };
    if (this.me !== undefined) note(this.me.handle, this.attestor.did);
    for (const entry of this.directory) note(entry.agent.handle, entry.agent.did);
    for (const entry of this.connections) note(entry.withAgent.handle, entry.withAgent.did);
    return pairs;
  }

  /**
   * What to write on screen for each key.
   *
   * The bare handle while it is unambiguous among everyone this bridge knows, and as much
   * fingerprint as it takes to separate them once it is not — see `displayTag`. Computed over
   * everyone known rather than per room, so somebody does not change name between screens.
   */
  private labels(): Record<string, string> {
    const named = this.taggedNames();
    const everyone = [...named.values()];
    const out: Record<string, string> = {};
    for (const [did, full] of named) out[did] = displayTag(full, everyone);
    return out;
  }

  /** How to name one key in a log line, falling back to its short form when unknown. */
  private label(did: string): string {
    return this.labels()[did] ?? `a key with fingerprint ${fingerprint(did) ?? "unknown"}`;
  }

  /** Short forms for every key on screen: mine, the directory's, and any that was renamed. */
  private fingerprints(): Record<string, string> {
    const dids = [
      this.attestor.did,
      ...this.directory.flatMap((entry) => (entry.agent.did !== undefined ? [entry.agent.did] : [])),
      ...this.connections.flatMap((entry) =>
        entry.withAgent.did !== undefined ? [entry.withAgent.did] : [],
      ),
      ...this.known.all().map((conflict) => conflict.did),
    ];
    const out: Record<string, string> = {};
    for (const did of dids) {
      const short = fingerprint(did);
      if (short !== undefined) out[did] = short;
    }
    return out;
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
      // Room members as well as people you know. `conversation.add` spends the adder's
      // connection, so a room's third member can be somebody you have never been introduced
      // to — and their key still has to be pinned before anything is sealed to it.
      ...this.conversations.flatMap((conversation) =>
        conversation.participants.map((member) => ({ handle: member.handle, did: member.did })),
      ),
    ];
    for (const { handle, did } of seen) {
      if (did === undefined || did === this.attestor.did) continue;
      const conflict = this.known.offer(did, handle);
      if (conflict !== undefined) {
        hubLog.error(
          `the key this machine knows as @${conflict.known} is now calling itself ` +
            `@${conflict.offered}. Compare fingerprints before treating it as either.`,
        );
      }
    }
  }

  /**
   * Take delivery of one line: judge it, then open it. Always in that order.
   *
   * Verifying covers the ciphertext, so it is checkable by anybody holding the author's
   * signing key — including a bridge that will turn out to have no key for the words inside.
   * Doing it the other way round would mean deciding whether to trust something on the basis
   * of plaintext this bridge produced itself, which proves nothing about who wrote it.
   */
  private receive(message: Message, replay = false): void {
    this.judge(message, replay);
    // Only an agent's own words are sealed. `system` is the hub talking about the room in
    // its own voice, with no key and nothing private to say; `pass` is silence.
    if (message.kind !== "agent") return;
    this.opened.set(message.id, this.sealer.open(message.text, message.conversationId));
  }

  /**
   * One line as the agent should read it: its words, or a sentence saying it missed one.
   *
   * Never the ciphertext, and never silence. An agent handed an envelope would read the JSON
   * as the other party's words; an agent handed nothing would answer a conversation with a
   * hole in it as though the hole were not there.
   */
  private wordsFor(message: Message): Message {
    if (message.kind !== "agent") return message;

    // The fallback covers a line arriving with the turn that dispatched it, before the
    // `appended` that would have opened it. Opening twice is cheap; handing over an envelope
    // is not.
    const opened =
      this.opened.get(message.id) ?? this.sealer.open(message.text, message.conversationId);
    return withWords(message, opened);
  }

  /** Judge one message and remember the verdict for the app. */
  private judge(message: Message, replay = false): Verdict {
    const verdict = this.attestor.check(
      message,
      { expectedDid: message.authorDid },
      { replay },
    );
    this.verdicts.set(message.id, verdict);
    if (verdict.state === "broken") {
      hubLog.error(`a message from ${this.label(message.authorDid)} did not check out: ${verdict.why}`);
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

    // Every key on this hub wearing that name, not the first one found. Two friends who both
    // go by @mira is the ordinary case now, and picking one of them silently would be this
    // bridge choosing somebody's correspondent for them.
    const wearing = this.directory.filter((entry) => entry.agent.handle === parsed.handle);
    if (wearing.length > 1 && parsed.fingerprint === undefined) {
      const choices = wearing
        .map((entry) => (entry.agent.did === undefined ? undefined : tag(parsed.handle, entry.agent.did)))
        .filter((named): named is string => named !== undefined);
      return {
        error:
          `${String(wearing.length)} agents here go by @${parsed.handle}. ` +
          `Say which: ${choices.join(", ")}`,
      };
    }
    const offered = wearing[0]?.agent.did;
    if (parsed.fingerprint !== undefined) {
      if (offered === undefined) {
        return {
          error: `this hub has no key for @${parsed.handle}, so the fingerprint proves nothing`,
        };
      }
      const wanted = wearing.find(
        (entry) => entry.agent.did !== undefined && fingerprint(entry.agent.did) === parsed.fingerprint,
      )?.agent.did;
      if (wanted !== undefined) {
        // Checked by a person, so it supersedes anything pinned on a hub's say-so alone.
        void this.known.repin(parsed.handle, wanted);
        this.send({
          t: "invite.send",
          toDid: wanted,
          purpose,
          ...(limit !== undefined ? { limit } : {}),
        });
        return undefined;
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

    // Resolved here rather than on the hub: by the time a frame is built the sender has
    // already decided which @mira they meant, and sending the name instead would hand that
    // decision back to whoever is routing it.
    if (offered === undefined) {
      return { error: `this hub has no key for @${parsed.handle}, so there is nobody to invite` };
    }
    this.send({
      t: "invite.send",
      toDid: offered,
      purpose,
      ...(limit !== undefined ? { limit } : {}),
    });
    return undefined;
  }

  /** Accept a key's new name, after a person has looked at the fingerprints and decided. */
  async trustNewName(did: string): Promise<void> {
    const conflict = this.known.conflict(did);
    if (conflict === undefined) return;
    await this.known.repin(did, conflict.offered);
    hubLog.info(`now known as @${conflict.offered}`, { was: `@${conflict.known}` });
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

  /**
   * Record a refusal, say what would fix it, and stop reconnecting.
   *
   * The remedy is the point. "no agent has claimed that key" is a true sentence that leaves
   * somebody staring at a log, and the loop that used to follow it said "can't reach the hub"
   * about a hub that was answering — two ways of being unhelpful about a problem with one
   * concrete fix.
   */
  private refuse(reason: RefusalReason, detail: string): void {
    const remedy = remedyFor(reason, this.hubUrl);
    this.refusal = { reason, detail, remedy, claimable: reason === "unclaimed-key" };
    this.lastError = `${detail} — ${remedy}`;
    hubLog.error(detail, { hub: this.hubUrl });
    hubLog.error(remedy);
    this.publish();
  }

  /**
   * Try the hub again after whatever it refused has been dealt with.
   *
   * The only way out of a refusal, and deliberately so: nothing about waiting changes a
   * hub's answer, so the loop does not resume on its own. Something has to have happened —
   * a handle claimed, a key repaired — and this is the caller saying it did.
   */
  resume(): void {
    if (this.refusal === undefined || this.closing) return;
    this.refusal = undefined;
    this.lastError = undefined;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.diagnosed = false;
    this.publish();
    this.open();
  }

  private open(): void {
    if (this.refusal !== undefined) return;
    const url = new URL("/socket", this.hubUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url.toString());
    this.socket = socket;

    // Every way this socket can end funnels through here, so the reconnect is scheduled once
    // however it died: closed by the hub, timed out connecting, or given up on for silence.
    // Three paths that each scheduled their own retry would race into two live sockets.
    let retired = false;
    const retire = (why: string): void => {
      if (retired) return;
      retired = true;
      clearTimeout(connecting);
      socket.close();
      // Already replaced, so its ending is not news and the socket that supplanted it owns
      // the reconnect.
      if (this.socket !== socket) return;
      this.stopKeepalive();
      this.connectedToHub = false;
      // Not on a deliberate shutdown: that is not a failure, and the app is about to close
      // anyway. Cleared automatically the moment `open` succeeds again.
      //
      // Nor once this outage has been diagnosed: the retry line is generic by necessity, and
      // letting it land every thirty seconds would paper over the one message that says what
      // to actually do about it.
      if (!this.closing && !this.diagnosed && this.refusal === undefined) {
        this.lastError = `can't reach the hub at ${this.hubUrl} — retrying`;
      }
      this.publish();
      if (this.closing) return;
      // A door that said no. Retrying is not resilience here: the answer does not depend on
      // when it is asked, so the loop would run until somebody killed it while reporting an
      // outage that is not happening.
      if (this.refusal !== undefined) {
        hubLog.warn("not retrying — the hub refused this key, not the connection");
        return;
      }
      // Backoff, because a hub that is down stays down for a while and hammering it helps
      // nobody. Capped so a laptop that slept overnight still rejoins within half a minute.
      hubLog.warn(`${why}, retrying`, { in: `${String(this.reconnectDelay)}ms` });
      setTimeout(() => this.open(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      // Only once the backoff has topped out, which is about a minute of failing: before that
      // this is most likely a hub being restarted, and saying "it is gone" of a hub that is
      // three seconds from coming back would be worse than saying nothing.
      if (!this.diagnosed && this.reconnectDelay >= RECONNECT_MAX_MS) void this.diagnose();
    };

    const connecting = setTimeout(() => {
      retire(`no answer from ${this.hubUrl} within ${String(CONNECT_TIMEOUT_MS / 1000)}s`);
    }, CONNECT_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      clearTimeout(connecting);
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.connectedToHub = true;
      this.lastError = undefined;
      this.lastHeard = Date.now();
      this.diagnosed = false;
      this.startKeepalive(socket, retire);
      hubLog.info("connected", { url: this.hubUrl });
      // Nothing is said until the hub asks. The introduction is a signature over the
      // challenge it is about to send, so there is no secret to present and none to steal.
      this.publish();
    });

    socket.addEventListener("message", (event) => {
      // Before parsing, and for every frame rather than only for a pong: what the keepalive
      // is asking is whether anything at all is still coming back.
      this.lastHeard = Date.now();
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

    socket.addEventListener("close", (event) => {
      const code = "code" in event ? (event as CloseEvent).code : undefined;
      const reason = "reason" in event ? (event as CloseEvent).reason : "";
      // The close code carries the verdict too, so a socket that died before its `refused`
      // frame could be read still ends deliberately rather than going round again. The reason
      // text is the hub's own word for it; anything unrecognised is treated as the general
      // case, which is the safe way to be wrong here.
      if (code === REFUSED_CLOSE_CODE && this.refusal === undefined) {
        this.refuse(asRefusalReason(reason), "the hub refused this key at the door");
      }
      retire(`disconnected by the hub (code ${String(code ?? "?")}${reason ? `: ${reason}` : ""})`);
    });

    socket.addEventListener("error", () => {
      // `close` always follows, and that is where reconnection is handled. Swallowing here
      // keeps one reconnect path rather than two that can race.
    });
  }

  /**
   * Work out why the hub has stopped answering, and say so.
   *
   * The reconnect loop keeps running either way — a name that has stopped resolving may just
   * be DNS having a bad minute, and this end is in no position to be certain. What changes is
   * what the person is told: "retrying" is true but useless when the URL is never going to
   * work again, and the fix for that case is one flag they cannot guess.
   */
  private async diagnose(): Promise<void> {
    this.diagnosed = true;
    const check = await checkHub(this.hubUrl);
    if (check.kind === "ok" || this.closing) return;
    hubLog.warn(`${this.hubUrl} — ${describeHub(check)}`);
    for (const line of explainHub(this.hubUrl, check)) hubLog.warn(line);
    this.lastError = summariseHub(this.hubUrl, check);
    this.publish();
  }

  /**
   * Ping the hub on a timer, and give up on a socket that stops answering.
   *
   * Both halves matter and neither is enough alone: the ping is what stops an idle socket
   * being reaped as abandoned, and the silence check is what notices when it was reaped
   * anyway somewhere this end cannot see.
   */
  private startKeepalive(socket: WebSocket, retire: (why: string) => void): void {
    this.stopKeepalive();
    this.keepalive = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const silent = Date.now() - this.lastHeard;
      if (silent > SILENCE_LIMIT_MS) {
        retire(`nothing from the hub for ${String(Math.round(silent / 1000))}s`);
        return;
      }
      socket.send(JSON.stringify({ t: "ping" } satisfies ClientFrame));
    }, KEEPALIVE_EVERY_MS);
  }

  private stopKeepalive(): void {
    if (this.keepalive === undefined) return;
    clearInterval(this.keepalive);
    delete this.keepalive;
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
        this.opened.clear();
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
          this.receive(message, true);
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

      case "challenge": {
        const sealing = this.sealingClaim ?? this.attestor.bindSealingKey(this.sealer.sealingDid);
        this.sealingClaim = sealing;
        this.send({
          t: "hello",
          did: this.attestor.did,
          challenge: frame.nonce,
          signature: this.attestor.answer(frame.nonce),
          sealing,
        });
        return;
      }

      case "directory":
        this.directory = frame.people;
        this.pinKnownKeys();
        this.publish();
        return;

      case "invite":
        hubLog.info(`invite ${frame.invite.status}`, {
          from: this.label(frame.invite.fromDid),
          to: this.label(frame.invite.toDid),
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
        for (const message of this.messages.get(frame.conversationId) ?? []) {
          this.opened.delete(message.id);
        }
        this.messages.delete(frame.conversationId);
        this.presence.delete(frame.conversationId);
        this.activity.delete(frame.conversationId);
        this.toolCalls.delete(frame.conversationId);
        this.atStart.delete(frame.conversationId);
        this.publish();
        return;

      case "appended": {
        const arrived = frame.message;
        const list = this.messages.get(arrived.conversationId) ?? [];
        if (!list.some((message) => message.id === arrived.id)) {
          this.messages.set(arrived.conversationId, [...list, arrived]);
        }
        this.receive(arrived);
        // Our own message landing means our turn is over; anything else leaves us as we were.
        if (arrived.authorDid === this.attestor.did) {
          this.attestor.confirmOwn(arrived);
          this.activity.set(arrived.conversationId, { state: "idle" });
          await this.recordOutgoing(arrived);
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
        // Checked like everything else, judged against itself, and not settled: these are
        // older than the running position and must not move it backwards.
        this.attestor.startWindow();
        for (const message of frame.messages) this.receive(message, true);
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

      // The door, not the conversation. Recorded rather than retried: `retire` reads this and
      // stops, which is the whole difference between a hub that is down and a hub that has
      // made up its mind.
      case "refused":
        this.refuse(frame.reason, frame.detail);
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

    // The words, not the envelope. This file is the durable local record of what this agent
    // said — the copy that survives the hub erasing the room — and a record of ciphertext
    // this machine happened to be able to read once is not a record of anything.
    //
    // A line of our own that will not open should be impossible: `toRoom` seals to the sender
    // before anybody else, precisely so there is one read path. If it ever happens it is a
    // key that has gone missing under a running bridge, which is worth stopping over rather
    // than filing a placeholder and moving on.
    const opened = this.opened.get(message.id);
    if (opened?.state !== "opened") {
      this.lastError =
        "a line this agent just sent could not be read back, so it was not written to the local record. Your sealing keys may be damaged.";
      log.error("own message did not open", { id: message.id, why: opened?.state ?? "missing" });
      // The steer belongs to this line. Leaving it parked would file it against whatever this
      // agent says next, in some later turn, as the thing that prompted it.
      this.pendingSteer.delete(message.conversationId);
      return;
    }

    const conversation = this.conversations.find(
      (candidate) => candidate.id === message.conversationId,
    );
    const other =
      conversation?.participants.find((member) => member.handle !== this.me?.handle)?.handle ??
      "them";
    const steer = this.pendingSteer.get(message.conversationId);
    this.pendingSteer.delete(message.conversationId);

    const entry: LedgerEntry = {
      id: message.id,
      at: message.at,
      conversationId: message.conversationId,
      to: other,
      text: opened.text,
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
   * Seal one line to everybody in a room, or say why it cannot be.
   *
   * Every reason to refuse is a reason the *other side* would never have learned about: a
   * member with no published key, a key signed by something other than what is pinned, an
   * envelope that would not build. Each of those, sent anyway, produces a room that looks
   * ordinary to everybody except the person who cannot read it.
   *
   * The plaintext ceiling is enforced here because this is the last place it can be. The hub
   * bounds the blob and has no way to bound the words, which is the trade the whole change
   * makes: it keeps a size limit and gives up a content one.
   */
  private sealForRoom(
    conversationId: string,
    text: string,
  ): { envelope: string } | { error: string } {
    const me = this.me;
    if (me === undefined) return { error: "this bridge does not know who it is yet" };

    if (text.length > MAX_MESSAGE_LENGTH) {
      return {
        error: `your agent wrote ${String(text.length)} characters and the limit is ${String(MAX_MESSAGE_LENGTH)}`,
      };
    }

    const conversation = this.conversations.find((candidate) => candidate.id === conversationId);
    if (conversation === undefined) return { error: "this room is not one this bridge is in" };

    const recipients = recipientsFor(conversation.participants, this.attestor.did, (did) =>
      this.known.handleOf(did) !== undefined,
    );
    if (recipients.state === "refused") return { error: recipients.why };

    const envelope = this.sealer.toRoom(text, recipients.sealingDids, conversationId);
    if (envelope === undefined) return { error: "the envelope could not be built" };
    return { envelope };
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
    const room = (conversation?.participants ?? [])
      .filter((member) => member.did !== this.attestor.did)
      .map((member) => this.label(member.did));
    // Opened, not judged: these arrived as `appended` and were checked then. What the agent
    // must never be handed is the ciphertext, which it would read as the words.
    const readable = transcript.map((message) => this.wordsFor(message));

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
        nameFor: (did) => this.label(did),
        purpose,
        transcript: readable,
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
   * The hub cannot see a model thinking; all it has is silence. See `docs/design/turns.md`.
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
        // Sealed before anything is committed to, for the reason the steer is: a line that
        // cannot be sealed must never fall back to being sent in the clear. The hub is the
        // party this is sealed against, and it is also the party a fallback would hand the
        // words to.
        const sealed = this.sealForRoom(conversationId, result.text);
        if ("error" in sealed) {
          daemonLog.error("refused to send an unsealable line", {
            conversation: conversationId,
            why: sealed.error,
          });
          this.lastError = `your agent answered, and the line was not sent: ${sealed.error}`;
          this.activity.set(conversationId, { state: "idle" });
          this.dispatches.delete(conversationId);
          // The room is told the turn failed rather than left waiting out the deadline. What
          // it is told is that sealing failed, never the words that could not be sealed.
          this.send({
            t: "trouble",
            conversationId,
            dispatch,
            reason: `could not seal this line to everyone in the room: ${sealed.error}`.slice(0, 300),
          });
          this.publish();
          return;
        }

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
          text: sealed.envelope,
          authorship: this.attestor.speak(conversationId, "agent", dispatch, sealed.envelope),
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
