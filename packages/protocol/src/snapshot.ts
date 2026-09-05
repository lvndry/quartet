/**
 * @fileoverview What the bridge shows the browser — and the app's only door into this package.
 *
 * The other wire. `index.ts` is bridge↔hub; this is bridge↔app, and it is a wire for exactly
 * the same reason: two processes, one pushing whole snapshots and the other rendering them.
 *
 * Reached as `@quartet/protocol/app`, which is the whole of what the browser may import. The
 * hub wire is a separate entry point the app does not have, so a frame can be changed for the
 * hub's benefit without the page silently following it. See `docs/design/packages.md`.
 *
 * It exists because the two ends had a copy each. The bridge's types lived across half a
 * dozen of its own modules and the app re-declared each of them by hand, mutable where the
 * bridge's were readonly and looser where the bridge's were unions — so `Activity` was a flat
 * bag of optional fields on one side and a discriminated union on the other, and nothing
 * anywhere would have failed if a field had been renamed on one side only. A snapshot is a
 * contract; contracts get one definition.
 *
 * Shapes only, and nothing that parses. The app talks to a process on its own machine over
 * loopback, so unlike a hub frame this does not cross a trust boundary and there is nothing
 * here worth checking defensively. The handful of values below come from `./limits`, which
 * has no zod in it — so importing this door does not drag a parser into the page's bundle,
 * and the shapes taken from `./index` are type-only and erased at build.
 */

import type {
  Agent,
  Connection,
  Conversation,
  DirectoryEntry,
  Invite,
  Message,
  PeerPresence,
} from "./index";

/**
 * The hub's shapes that a snapshot genuinely carries, passed through on purpose.
 *
 * These are the seam. A snapshot is mostly this machine's own reading of things — verdicts,
 * openings, activity — but the rooms and lines it describes are the hub's, and re-declaring
 * them here would be the hand-mirroring this file exists to abolish.
 *
 * Passed through rather than re-stated, so there is one definition; listed explicitly rather
 * than re-exported wholesale, so that the list is short enough to be an argument. Anything
 * added here is the app learning one more thing about the hub, which is the direction the
 * boundary is meant to resist.
 */
export type { Agent, Connection, Conversation, DirectoryEntry, Invite, Message, PeerPresence };

/**
 * The bounds a form has to know to refuse an input before the hub does.
 *
 * A field that accepts what the wire will reject is a field that lies. These are the only
 * values — as opposed to types — the app takes from this package.
 */
export {
  DEFAULT_TURN_BUDGET,
  MAX_ROOM_MEMBERS,
  MAX_SPEND_USD,
  MAX_TURN_BUDGET,
  UNLIMITED_TURN_BUDGET,
  MAX_MESSAGE_LENGTH,
  DEFAULT_LIMIT,
} from "./limits";
export type { Limit } from "./limits";

/** A question jazz has parked a run on, waiting for a person to answer it. */
export interface HumanQuestion {
  readonly question: string;
  readonly suggestions: readonly {
    readonly value: string;
    readonly label?: string;
    readonly description?: string;
  }[];
  readonly allowCustom: boolean;
  readonly allowMultiple: boolean;
}

/** What your own agent is doing right now, per conversation. Drives the app's live states. */
export type Activity =
  | { readonly state: "idle" }
  | {
      readonly state: "thinking";
      readonly since: number;
      /** What the daemon last said it was doing. A tool name, not a thought. */
      readonly doing?: string;
    }
  | {
      readonly state: "needs-you";
      readonly runId: string;
      readonly pending:
        | { readonly kind: "approval"; readonly message?: string }
        | { readonly kind: "question"; readonly question: HumanQuestion };
    };

/**
 * One tool call, as this machine's daemon reported it.
 *
 * `result` never leaves this machine — it is output from this machine's disk, shell and
 * network, and what crosses the wire stays the tool's name alone.
 */
export interface ToolCall {
  /** The daemon's id for the call, or one made up locally. Pairs a start with its finish. */
  readonly id: string;
  readonly name: string;
  readonly state: "running" | "ok" | "failed" | "needs-you";
  /** What the call returned, clipped. Local only. */
  readonly result?: string;
  /** Whether `result` is the whole of what came back, or where it was cut. */
  readonly clipped?: boolean;
  readonly at: number;
}

/** An aside you typed to your own agent. Local only — it never reaches the other party. */
export interface Aside {
  readonly at: string;
  readonly conversationId: string;
  readonly text: string;
}

/**
 * What checking one message's signature concluded.
 *
 * `unsigned` and `broken` are kept apart because they mean opposite things about the sender.
 * Unsigned is the hub speaking in its own voice; broken is a claim of authorship that failed,
 * which is either two builds disagreeing or somebody in the middle.
 */
export type Verdict =
  | { readonly state: "signed" }
  | { readonly state: "unsigned" }
  | { readonly state: "broken"; readonly why: string };

/**
 * What this machine got when it tried to read a line.
 *
 * Kept apart from `Verdict` because they answer different questions and a person needs both.
 * A verdict is about the author — did they really write this. This is about the reader — can
 * I read it. A perfectly signed line can be unreadable, and an unreadable line is not a
 * damaged one.
 *
 * `sealed-to-others` is ordinary and is what every line written before you joined a room
 * looks like. `unopenable` is a key that should have worked and did not, which is damage or
 * forgery and worth saying loudly.
 */
export type Opened =
  | { readonly state: "opened"; readonly text: string }
  | { readonly state: "sealed-to-others" }
  | { readonly state: "unopenable" };

/** A key that changed its name under us, and what it changed between. */
export interface Conflict {
  readonly did: string;
  /** What this key was calling itself when this machine first saw it. */
  readonly known: string;
  /** What it is calling itself now. */
  readonly offered: string;
}

/** One line this machine sent, as its own durable record of it. */
export interface LedgerEntry {
  /** The hub's id for the message. Dedupes replays and reconnects. */
  readonly id: string;
  readonly at: string;
  readonly conversationId: string;
  readonly to: string;
  readonly text: string;
  readonly steer?: string;
}

/** One of this machine's jazz agents, as the roster lists it. */
export interface JazzAgent {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly persona?: string;
  readonly tools: readonly string[];
}

/** Why the roster could not be read, in the terms the app has to say something about. */
export type JazzProblem = "unreachable" | "unauthorized" | "unsupported" | "failed";

/** The fixed vocabularies an agent editor's menus are built from. */
export interface JazzCatalog {
  readonly providers: readonly string[];
  readonly webSearchProviders: readonly string[];
  readonly reasoningEfforts: readonly string[];
  /**
   * The jobs an agent can bind a companion for, each `"<action>:<modality>"`.
   *
   * Action and modality are separate axes because a model rarely does both — most models
   * that read an image cannot draw one — so `analyze:image` and `generate:image` are
   * independent slots on the same agent.
   */
  readonly companionRoles: readonly string[];
}

/**
 * One model a provider serves.
 *
 * The capability flags are not description, they are what makes a form field meaningful: a
 * temperature input on a model that ignores temperature is a control that silently does
 * nothing, and every current Claude reasoning model reports `supportsTemperature: false`.
 */
export interface JazzModel {
  readonly id: string;
  readonly displayName?: string;
  readonly supportsTools: boolean;
  readonly supportsTemperature: boolean;
  readonly isReasoningModel: boolean;
  readonly inputPricePerMillion?: number;
  readonly outputPricePerMillion?: number;
}

export interface JazzPersona {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tone?: string;
  readonly style?: string;
}

export interface JazzTools {
  readonly tools: readonly string[];
  readonly categories: Readonly<Record<string, readonly string[]>>;
  /**
   * Which tools an agent gets whether or not anyone asked for them.
   *
   * Required, because a tool picker cannot be honest without it: `config.tools` only ever
   * adds, so without knowing which tools arrive anyway a checkbox cannot say whether
   * unticking it would do anything.
   */
  readonly defaultTools: readonly string[];
}

/** Full config, minus the api keys jazz will not hand out. Shape follows jazz's own. */
export type JazzAgentConfig = Readonly<Record<string, unknown>>;

/** One agent in full, for the editor. Api keys are never served, only which providers set one. */
export interface JazzAgentDetail {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly persona: string;
  readonly provider: string;
  readonly model: string;
  readonly tools: readonly string[];
  readonly config: JazzAgentConfig;
  /**
   * Providers with a per-agent key override.
   *
   * The keys themselves are never served, so this is how an editor says "a key is set"
   * honestly instead of rendering a blank box that means either "unset" or "hidden".
   */
  readonly apiKeyProviders: readonly string[];
}

/**
 * Everything the app knows, as one value.
 *
 * The bridge pushes the whole thing on every change rather than a stream of deltas. For a
 * two-person conversation that is a few kilobytes, and it buys the absence of a second
 * incremental protocol that could drift out of step with the first.
 */
export interface BridgeState {
  readonly connectedToHub: boolean;
  readonly me?: Agent;
  /** `provider/model` for the jazz agent answering on this machine, when jazz will say. */
  readonly myModel?: string;
  /** This machine's jazz agents. Not hub agents — those are `directory`. */
  readonly jazzAgents: readonly JazzAgent[];
  /** Which of them speaks for you here. */
  readonly myAgentId?: string;
  readonly jazzProblem?: JazzProblem;
  /** The menus an agent editor is built from. Absent when this jazz is too old to serve them. */
  readonly jazzCatalog?: JazzCatalog;
  readonly connections: readonly Connection[];
  readonly conversations: readonly Conversation[];
  readonly invites: readonly Invite[];
  readonly directory: readonly DirectoryEntry[];
  readonly messages: Readonly<Record<string, readonly Message[]>>;
  /** Whether the oldest message held for a room really is the room's first. */
  readonly atStart: Readonly<Record<string, boolean>>;
  readonly asides: Readonly<Record<string, readonly Aside[]>>;
  readonly activity: Readonly<Record<string, Activity>>;
  /**
   * What your own agent's current turn has actually done, per conversation.
   *
   * Never leaves this machine: the hub is told a tool's name and nothing else. See `ToolCall`.
   */
  readonly toolCalls: Readonly<Record<string, readonly ToolCall[]>>;
  /** Everyone in each room but you. Empty until the hub says otherwise. */
  readonly presence: Readonly<Record<string, readonly PeerPresence[]>>;
  readonly ledger: readonly LedgerEntry[];
  /**
   * What checking each message's signature concluded, by message id.
   *
   * Carried beside the messages rather than folded into them: a verdict is this machine's
   * conclusion, not part of what was said, and putting it inside a Message would make it look
   * like something the hub had told us.
   */
  readonly verdicts: Readonly<Record<string, Verdict>>;
  /**
   * The words behind each sealed line, by message id.
   *
   * Beside the messages for the same reason the verdicts are, and it matters more here: a
   * `Message.text` is the sealed blob the author signed and the hub relayed, and the words
   * are what *this machine* recovered from it. Folding them into the message would leave a
   * signature sitting next to text it does not cover — so anything that checked it later
   * would conclude the transcript had been tampered with, which is the one alarm that must
   * never go off for a reason other than tampering.
   *
   * Only `agent` lines appear here. `system` is the hub's own voice, in the clear on
   * purpose, and `pass` is silence. A renderer that has no entry for an agent line has the
   * ciphertext and should say so rather than print it.
   */
  readonly opened: Readonly<Record<string, Opened>>;
  /**
   * Keys that have started calling themselves something else.
   *
   * Surfaced rather than resolved. A rename is somebody changing their mind about as often as
   * it is somebody walking into a room wearing a name that means another person there, and a
   * bridge cannot tell the two apart — but a person who compares a fingerprint can, and they
   * cannot do that if nobody tells them.
   */
  readonly keyConflicts: readonly Conflict[];
  /**
   * How to write each key on screen, by did: `@mira` alone, or `@mira#4f2a` where two share
   * the name. Computed here so every surface renders one name for one key.
   */
  readonly labels: Readonly<Record<string, string>>;
  /**
   * The readable short form of every key this bridge can name, by did.
   *
   * Computed in the bridge because the app runs in a browser and the digest comes from
   * `node:crypto`. Shipping the derived string rather than teaching the page to hash keeps one
   * implementation of what a fingerprint is, which is the only way two cannot disagree.
   */
  readonly fingerprints: Readonly<Record<string, string>>;
  /** Set when this machine's pin file could not be read, so no key here is vouched for. */
  readonly keyStoreProblem?: string;
  readonly lastError?: string;
}
