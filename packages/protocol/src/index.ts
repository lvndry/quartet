/**
 * @fileoverview The bridge↔hub wire, defined once for all three processes.
 *
 * Both directions cross a trust boundary, so every frame is parsed on receipt rather than
 * cast. Sharing the schemas is what stops the browser, the bridge and the hub drifting into
 * disagreeing about what a message is.
 *
 * Deliberately small. If this grows past a couple of dozen frames, the hub has started doing
 * something other than relaying.
 *
 * Why the model is shaped like this — rooms, turns, allowances, consent — is in
 * `docs/design`. Comments here cover only what is not obvious from the schema itself.
 */

import { z } from "zod";

// The bridge↔app snapshot. Types only, and no trust boundary, so it lives apart.
export * from "./snapshot";

/** How many agent turns one conversation may spend before a human has to speak again. */
export const DEFAULT_TURN_BUDGET = 50;

/** A sanity bound on a typed number. Anyone who wants no ceiling picks `none` instead. */
export const MAX_TURN_BUDGET = 500;

/** Zero rather than null, so "unlimited" survives SQLite and JSON without a special case. */
export const UNLIMITED_TURN_BUDGET = 0;

export const MAX_SPEND_USD = 1000;

/**
 * How a conversation is allowed to spend. See `docs/design/spending.md`.
 *
 * `cost` is never the only bound: reported spend comes from participants' own bridges and
 * the hub cannot check it, so a turn count runs underneath every money ceiling.
 */
export const limitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turns"), turns: z.number().int().min(1).max(MAX_TURN_BUDGET) }),
  z.object({ kind: z.literal("cost"), usd: z.number().positive().max(MAX_SPEND_USD) }),
  z.object({ kind: z.literal("none") }),
]);
export type Limit = z.infer<typeof limitSchema>;

export const DEFAULT_LIMIT: Limit = { kind: "turns", turns: DEFAULT_TURN_BUDGET };

/** Nothing worth adding. A sentinel, because an empty reply also means "the model failed". */
export const PASS_SENTINEL = "<pass>";

/** A goodbye: delivered, and then the room closes with it. Distinct from a pass. */
export const CLOSE_SENTINEL = "<end>";

/**
 * A sanity ceiling for the room, not for the daemon.
 *
 * `composeTurnPayload` already trims a dispatch to whatever the local jazz will accept, so a
 * long message degrades a context window rather than failing a turn.
 */
export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_PURPOSE_LENGTH = MAX_MESSAGE_LENGTH;

/**
 * The same ceiling, measured after sealing.
 *
 * A sealed line travels as the JSON of an envelope, so the bound the hub can actually check
 * is on the ciphertext rather than the words. Base64 costs a third, GCM adds a nonce and a
 * tag, and every member of the room carries a wrapped key and a did of their own — so a
 * full room's worth of overhead on a maximum-length message is roughly
 * `4/3 × MAX_MESSAGE_LENGTH` plus a kilobyte of structure. Rounded up generously, because
 * the cost of guessing low is a legitimate message the hub refuses to relay.
 *
 * It bounds a blob the hub cannot read, which is the point: the hub keeps a size limit
 * without regaining a content one.
 */
export const MAX_SEALED_LENGTH = 16_000;

/**
 * Text that survives being turned into bytes and back.
 *
 * An unpaired surrogate — which `JSON.parse` will happily produce from a `\uD800` escape —
 * encodes to the replacement character, so two different strings would sign identically.
 * That is the one property signing exists to rule out, so they are refused at the door.
 */
function signable(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.isWellFormed(), {
      message: "contains unpaired surrogates, which cannot be signed unambiguously",
    });
}

/**
 * How much transcript a welcome carries, and how much one page adds.
 *
 * Welcome hydrates every room this agent is in and runs on every reconnect, so an unwindowed
 * number here is the hub's worst query multiplied by however many people you know. Above the
 * window an agent answers from, so what you can see is never less than what it worked from.
 */
export const WELCOME_TRANSCRIPT_WINDOW = 60;
export const HISTORY_PAGE_SIZE = 60;

/**
 * How much of a room one dispatched turn carries. See `docs/design/turns.md`.
 *
 * A turn carries the increment, not a fixed window: the agent resumes a jazz thread that
 * already holds the rest. `TURN_OVERLAP` is insurance for the one turn where that thread is
 * genuinely cold; `TURN_SLICE_MAX` bounds somebody who comes back owed hundreds of messages.
 */
export const TURN_OVERLAP = 6;
export const TURN_SLICE_MAX = 100;

/**
 * How many agents one room may hold. A cost bound, not a schema one.
 *
 * Every spoken message wakes every other member, so a message in a room of six is five model
 * runs on five people's own keys.
 */
export const MAX_ROOM_MEMBERS = 6;

/**
 * The hub's name for one dispatched turn. See `docs/design/turns.md`.
 *
 * Required back on everything a turn produces, which is what makes "the room gave you the
 * floor" checkable rather than assumed. Not a secret from the hub, which mints it, nor from
 * the far side, which needs it to check the signature.
 */
export const dispatchSchema = z.string().min(8).max(64);

export const handleSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, dash and underscore only");

/**
 * What kinds of thing appear in the *shared* transcript.
 *
 * There is deliberately no "human" kind — what you type goes to your own agent, never to the
 * other party. See `docs/design/rooms.md`.
 */
export const messageKindSchema = z.enum(["agent", "pass", "system"]);
export type MessageKind = z.infer<typeof messageKindSchema>;

/**
 * What an author signed, travelling with what they said.
 *
 * The hub stores this and repeats it; it cannot produce one. Every field is covered by the
 * signature, so all of them have to travel for the far side to check it.
 */
export const signatureSchema = z.object({
  did: z.string(),
  /** The author's clock. The message's own `at` is the hub's receipt, a different claim. */
  authoredAt: z.string(),
  nonce: z.string(),
  /** Digest of this author's previous signature in this conversation; empty on their first. */
  prev: z.string(),
  /** The turn this line answers. */
  dispatch: z.string(),
  value: z.string(),
});
export type Signature = z.infer<typeof signatureSchema>;

/**
 * What a bridge attaches when it speaks. The hub fills in the rest of the signature.
 *
 * Required, not optional: opening a socket already means proving a key, so leaving room for
 * an unsigned line would only leave a way to talk a transcript down to unverifiable.
 */
export const authorshipSchema = z.object({
  authoredAt: z.string(),
  nonce: z.string(),
  prev: z.string(),
  signature: z.string(),
});
export type Authorship = z.infer<typeof authorshipSchema>;

/** Whether a room is running, and if not, who stopped it. See `docs/design/rooms.md`. */
export const roomStateSchema = z.enum(["proposed", "live", "halted", "closed"]);
export type RoomState = z.infer<typeof roomStateSchema>;

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** The agent this message is attributed to. A human aside is attributed to their agent. */
  authorHandle: z.string(),
  kind: messageKindSchema,
  text: z.string(),
  at: z.string(),
  /**
   * Absent on anything the hub said in its own voice. Absent is not the same as invalid, and
   * the app distinguishes them: one is the hub speaking, the other is a failed claim.
   */
  signature: signatureSchema.optional(),
});
export type Message = z.infer<typeof messageSchema>;

export const agentSchema = z.object({
  id: z.string(),
  handle: z.string(),
  displayName: z.string(),
  bio: z.string().optional(),
  /** The key this agent signs with. An agent without one can be talked to, not checked. */
  did: z.string().optional(),
  /** The person this agent acts for. Modelled so several agents can share one. */
  ownerId: z.string(),
  online: z.boolean(),
});
export type Agent = z.infer<typeof agentSchema>;

export const connectionSchema = z.object({
  id: z.string(),
  /** The other party. Your own side is never included — a connection is seen from one end. */
  withAgent: agentSchema,
  since: z.string(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const inviteStatusSchema = z.enum(["pending", "accepted", "declined"]);

export const inviteSchema = z.object({
  id: z.string(),
  fromHandle: z.string(),
  toHandle: z.string(),
  /** Doubles as the first conversation's purpose — nobody invites a stranger for no reason. */
  purpose: z.string(),
  limit: limitSchema,
  status: inviteStatusSchema,
  at: z.string(),
});
export type Invite = z.infer<typeof inviteSchema>;

/**
 * What one other person (and their agent) are doing in this room.
 *
 * `online` is their bridge, `watching` is their browser on this room, `thinking` is a turn in
 * flight on their machine — the thing you otherwise sit through as unexplained silence.
 */
export const peerPresenceSchema = z.object({
  handle: z.string(),
  online: z.boolean(),
  watching: z.boolean(),
  thinking: z.boolean(),
  /** When their current turn started, so the other side can show elapsed time. */
  since: z.number().optional(),
  /** A tool name, not a thought. Both sides get it: four minutes of silence looks broken. */
  doing: z.string().max(200).optional(),
});
export type PeerPresence = z.infer<typeof peerPresenceSchema>;

export const conversationSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  /** Names the room in the list, and tells both agents what they are here to do. */
  purpose: z.string(),
  participants: z.array(z.string()),
  budgetRemaining: z.number(),
  limit: limitSchema,
  /**
   * Cost reported so far, in USD — an estimate, not an attested figure.
   *
   * Supplied by participants' own bridges, which the hub cannot check. Also a floor, when a
   * turn ran on a model without pricing. `budgetRemaining` is the bound that is enforced.
   */
  spentUSD: z.number(),
  spendIncomplete: z.boolean(),
  state: roomStateSchema,
  /**
   * The handle that opened this room.
   *
   * Stored rather than read off `participants[0]`: whose turn it is to accept is a question
   * about consent, and reading it off an array's order would let adding a member change it.
   */
  proposedBy: z.string(),
  /** Handles whose agents have said goodbye and will not be woken by the room again. */
  bowedOut: z.array(z.string()),
  /** Handles who have asked to erase this room for everyone. It goes when all of them have. */
  eraseAsked: z.array(z.string()),
  lastAt: z.string(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const directoryEntrySchema = z.object({
  agent: agentSchema,
  /** Whether you are already connected — the directory is also how you see who you know. */
  connected: z.boolean(),
  invitePending: z.boolean(),
});
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

/* ------------------------------------------------------------------ */
/* bridge → hub                                                        */
/* ------------------------------------------------------------------ */

export const clientFrameSchema = z.discriminatedUnion("t", [
  /**
   * Prove the key, rather than present a secret.
   *
   * Answers the `challenge` the hub sends when the socket opens. One credential, one place it
   * lives, and nothing on the wire worth stealing. See `docs/design/identity.md`.
   */
  z.object({
    t: z.literal("hello"),
    did: z.string(),
    challenge: z.string(),
    signature: z.string(),
  }),
  z.object({
    t: z.literal("profile.set"),
    handle: handleSchema,
    displayName: z.string().min(1).max(64),
    bio: z.string().max(200).optional(),
  }),
  z.object({ t: z.literal("directory.list") }),
  z.object({
    t: z.literal("invite.send"),
    toHandle: handleSchema,
    purpose: signable(MAX_PURPOSE_LENGTH),
    limit: limitSchema.optional(),
  }),
  z.object({
    t: z.literal("invite.respond"),
    inviteId: z.string(),
    accept: z.boolean(),
  }),
  z.object({
    t: z.literal("conversation.open"),
    connectionId: z.string(),
    purpose: signable(MAX_PURPOSE_LENGTH),
    limit: limitSchema.optional(),
  }),
  /**
   * Take up a proposed conversation, or turn it down. Sent by whoever did not open it.
   *
   * Declining closes the room rather than deleting it, so the proposer learns the answer
   * instead of watching their invitation disappear.
   */
  z.object({
    t: z.literal("conversation.respond"),
    conversationId: z.string(),
    accept: z.boolean(),
  }),
  /** Either participant may set it: it caps their own agent as much as the other's. */
  z.object({
    t: z.literal("limit.set"),
    conversationId: z.string(),
    limit: limitSchema,
  }),
  /** The kill switch that makes an unlimited allowance defensible. */
  z.object({ t: z.literal("conversation.stop"), conversationId: z.string() }),
  /**
   * Bring a closed conversation back.
   *
   * Its own frame rather than a side effect of choosing an allowance: `limit.set` clears a
   * halt because a new ceiling means "carry on", and that must not also undo a goodbye.
   */
  z.object({ t: z.literal("conversation.reopen"), conversationId: z.string() }),
  /**
   * Bring somebody into a room — only somebody you are already connected to.
   *
   * That connection is where consent to talk to you was given, and this spends it rather
   * than asking for something new. See `docs/design/rooms.md`.
   */
  z.object({
    t: z.literal("conversation.add"),
    conversationId: z.string(),
    handle: handleSchema,
  }),
  /** Leave a room. The last member out closes it rather than leaving it talking to itself. */
  z.object({ t: z.literal("conversation.leave"), conversationId: z.string() }),
  /**
   * Remove a conversation.
   *
   * `"me"` hides it: your membership goes, nobody is told, and it needs nobody's agreement
   * because it destroys nothing. `"everyone"` is a *request* to erase the hub's shared copy,
   * announced in the room and carried out once every current member has asked. Each side's
   * own bridge journal is a separate durable copy and is untouched either way.
   */
  z.object({
    t: z.literal("conversation.delete"),
    conversationId: z.string(),
    scope: z.enum(["me", "everyone"]),
  }),
  /** The agent's answer to a turn. The only way anything reaches the other party. */
  z.object({
    t: z.literal("say"),
    conversationId: z.string(),
    /** The turn being answered. Refused unless the hub dispatched it and is still owed it. */
    dispatch: dispatchSchema,
    text: signable(MAX_MESSAGE_LENGTH),
    /** The agent's last word. Delivered, then the conversation closes without a reply. */
    closing: z.boolean().optional(),
    /** What this turn cost, when the daemon could tell. An estimate — see `spentUSD`. */
    costUSD: z.number().nonnegative().optional(),
    costIncomplete: z.boolean().optional(),
    authorship: authorshipSchema,
  }),
  /**
   * The owner said something to their own agent.
   *
   * Refills the allowance and asks for a turn, carrying the owner's words as an instruction —
   * but they never enter the shared transcript, so the other party sees only what the agent
   * chooses to say next.
   */
  z.object({
    t: z.literal("nudge"),
    conversationId: z.string(),
    /**
     * Sealed to the sender's own key, and opaque here.
     *
     * A steer is a person talking to their own agent, and it round-trips through the hub only
     * because the hub is what schedules the turn — one bridge writes it and the same bridge
     * reads it back. There is nobody to agree a key with, so there is no reason for the hub to
     * ever hold these words. It stores the blob and hands it back.
     */
    steer: z.string().min(1).max(MAX_SEALED_LENGTH),
  }),
  z.object({
    t: z.literal("pass"),
    conversationId: z.string(),
    dispatch: dispatchSchema,
    costUSD: z.number().nonnegative().optional(),
    costIncomplete: z.boolean().optional(),
    /** A pass is silence, but it is *this agent's* silence, so it is signed like speech. */
    authorship: authorshipSchema,
  }),
  /** The run failed. Recorded so the room shows why it went quiet rather than just stopping. */
  z.object({
    t: z.literal("trouble"),
    conversationId: z.string(),
    dispatch: dispatchSchema,
    reason: z.string().max(300),
  }),
  /**
   * The turn is still in flight, but a person has to act before it can finish.
   *
   * Re-arms the deadline without settling, so approving a parked tool does not race the
   * silence timer.
   */
  z.object({
    t: z.literal("waiting"),
    conversationId: z.string(),
    dispatch: dispatchSchema,
  }),
  /**
   * This turn is still running.
   *
   * What makes the hub's deadline mean "the bridge has gone away" rather than "this turn is
   * slow". `note` is a tool name, not a thought, and it is the room's only window into a turn
   * that lasts minutes.
   */
  z.object({
    t: z.literal("progress"),
    conversationId: z.string(),
    dispatch: dispatchSchema,
    note: z.string().max(200).optional(),
  }),
  /**
   * This browser is looking at this conversation — or at none.
   *
   * Distinct from the socket being up: a bridge can stay connected overnight with nobody at
   * the desk. Watching is the person, not the process.
   */
  z.object({
    t: z.literal("watch"),
    conversationId: z.string().optional(),
  }),
  /**
   * Older messages, for a browser that has scrolled back past what welcome carried.
   *
   * Pulled rather than pushed: the alternative is every reconnect paying for transcripts
   * nobody reads.
   */
  z.object({
    t: z.literal("history.load"),
    conversationId: z.string(),
    /** Load the page immediately older than this message. */
    beforeId: z.string(),
  }),
  /**
   * Still here. Sent on a timer whenever the socket is up, whether or not a turn is running.
   *
   * An idle quartet socket used to carry nothing at all between turns, and everything in the
   * path — the hub's own idle timeout, a tunnel, a NAT table — treats a silent connection as
   * an abandoned one. The `progress` beat does not cover this: it only runs mid-turn, which
   * is the case that was never at risk.
   */
  z.object({ t: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

/* ------------------------------------------------------------------ */
/* hub → bridge                                                        */
/* ------------------------------------------------------------------ */

export const serverFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("welcome"),
    me: agentSchema,
    connections: z.array(connectionSchema),
    conversations: z.array(conversationSchema),
    invites: z.array(inviteSchema),
    /** Shared transcript for every room this agent is in. Hydrates the chat, not the ledger. */
    messages: z.array(messageSchema),
  }),
  /** Sent the moment a socket opens: sign this to say who you are. */
  z.object({ t: z.literal("challenge"), nonce: z.string() }),
  z.object({ t: z.literal("directory"), people: z.array(directoryEntrySchema) }),
  z.object({ t: z.literal("invite"), invite: inviteSchema }),
  z.object({
    t: z.literal("connected"),
    connection: connectionSchema,
    conversation: conversationSchema,
  }),
  z.object({ t: z.literal("conversation"), conversation: conversationSchema }),
  /** This conversation is gone. Drop it and its messages rather than diffing what changed. */
  z.object({ t: z.literal("conversation.removed"), conversationId: z.string() }),
  z.object({ t: z.literal("appended"), message: messageSchema }),
  /** Your move. See `docs/design/turns.md` for what the slice is and why it is not the room. */
  z.object({
    t: z.literal("turn"),
    conversationId: z.string(),
    /** Sent back on everything this turn produces. Anything else the hub refuses. */
    dispatch: dispatchSchema,
    purpose: z.string(),
    transcript: z.array(messageSchema),
    /**
     * How many messages come before that slice.
     *
     * Sent so the agent can be told plainly that the room did not begin where its transcript
     * does, rather than inferring a conversation that started mid-sentence.
     */
    earlier: z.number().int().nonnegative(),
    /**
     * Present when the owner asked for this turn. Trusted, unlike everything else here.
     *
     * Still sealed — this is the same blob the bridge sent as a `nudge`, handed back
     * unopened. The bridge unseals it on arrival, so the hub relays an instruction it has
     * never read.
     */
    steer: z.string().optional(),
    /** Sent when the allowance is nearly gone, so an agent can wind up its own point. */
    notice: z.string().optional(),
  }),
  /** The conversation's spending position changed — turns left, money reported, or the rule. */
  z.object({
    t: z.literal("budget"),
    conversationId: z.string(),
    remaining: z.number(),
    limit: limitSchema,
    spentUSD: z.number(),
    spendIncomplete: z.boolean(),
    state: roomStateSchema,
    bowedOut: z.array(z.string()),
  }),
  z.object({ t: z.literal("error"), detail: z.string() }),
  z.object({
    t: z.literal("presence"),
    conversationId: z.string(),
    /** Everyone in the room but you. Sent whole, so a member leaving is just a shorter list. */
    others: z.array(peerPresenceSchema),
  }),
  /**
   * Answer to a `ping`.
   *
   * The reply is the point, not the ping: a socket that can be written to but never answers
   * is exactly what a dropped tunnel leaves behind, and only a round trip tells them apart.
   */
  z.object({ t: z.literal("pong") }),
  /** One page of older messages, oldest first, in answer to `history.load`. */
  z.object({
    t: z.literal("history"),
    conversationId: z.string(),
    messages: z.array(messageSchema),
    /** True when this page reaches the start of the room and there is nothing older. */
    reachedStart: z.boolean(),
  }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

export function parseClientFrame(raw: unknown): ClientFrame | undefined {
  const parsed = clientFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Why a frame was rejected, in terms somebody can act on.
 *
 * A rejection is nearly always version skew, so the answer worth giving names the frame and
 * the field rather than saying the message was unrecognised.
 */
export function describeFrameRejection(raw: unknown): string {
  const parsed = clientFrameSchema.safeParse(raw);
  if (parsed.success) return "frame is valid";

  const named = typeof raw === "object" && raw !== null ? (raw as { t?: unknown }).t : undefined;
  const known = clientFrameSchema.options.map((option) => option.shape.t.value);
  if (typeof named !== "string") {
    return `frame has no "t" field naming its kind (expected one of ${known.join(", ")})`;
  }
  if (!known.includes(named as never)) {
    return `unknown frame "${named}" — this hub understands ${known.join(", ")}. A bridge and hub built from different commits will disagree like this.`;
  }

  const issue = parsed.error.issues[0];
  const at = issue?.path.join(".") ?? "?";
  return `frame "${named}" is malformed at ${at}: ${issue?.message ?? "invalid"}`;
}

export function parseServerFrame(raw: unknown): ServerFrame | undefined {
  const parsed = serverFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
