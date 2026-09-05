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

import {
  MAX_PURPOSE_LENGTH,
  MAX_SEALED_LENGTH,
  MAX_SPEND_USD,
  MAX_TURN_BUDGET,
  type Limit,
} from "./limits";

// The bridge↔app snapshot. Types only, and no trust boundary, so it lives apart.
export * from "./snapshot";

/**
 * The bounds, and the shape of a limit.
 *
 * Defined in `./limits` with no zod, so the app can import a ceiling without importing a
 * parser, and re-exported here so the hub wire's own callers see one module as before.
 */
export * from "./limits";

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
 * How a conversation is allowed to spend, as the wire checks it. See `docs/design/spending.md`.
 *
 * `cost` is never the only bound: reported spend comes from participants' own bridges and
 * the hub cannot check it, so a turn count runs underneath every money ceiling.
 */
export const limitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turns"), turns: z.number().int().min(1).max(MAX_TURN_BUDGET) }),
  z.object({ kind: z.literal("cost"), usd: z.number().positive().max(MAX_SPEND_USD) }),
  z.object({ kind: z.literal("none") }),
]);

/**
 * The schema and the type say the same thing, checked by the compiler.
 *
 * `Limit` used to be `z.infer<typeof limitSchema>`, which made drift impossible by
 * construction. It cannot be, now that the type has to exist on the zod-free side of the
 * boundary — so this stands in its place: add a variant to one and not the other, and this
 * stops compiling. Types only, so it costs nothing at runtime.
 */
type LimitsAgree = [Limit] extends [z.infer<typeof limitSchema>]
  ? [z.infer<typeof limitSchema>] extends [Limit]
    ? true
    : never
  : never;
const _limitsAgree: LimitsAgree = true;
void _limitsAgree;

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
  /**
   * The key this message is attributed to. A human aside is attributed to their agent.
   *
   * The key rather than the name, because a name is not an identifier: two agents may share
   * a handle, and a chain keyed by one would braid their signatures together. What a reader
   * *sees* is resolved from this did — see `displayTag`.
   */
  authorDid: z.string(),
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
  fromDid: z.string(),
  toDid: z.string(),
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
  did: z.string(),
  online: z.boolean(),
  watching: z.boolean(),
  thinking: z.boolean(),
  /** When their current turn started, so the other side can show elapsed time. */
  since: z.number().optional(),
  /** A tool name, not a thought. Both sides get it: four minutes of silence looks broken. */
  doing: z.string().max(200).optional(),
});
export type PeerPresence = z.infer<typeof peerPresenceSchema>;

/**
 * One agent's sealing key, signed by the agent it belongs to.
 *
 * The signing did is not repeated here — it is whatever the surrounding shape already says
 * this agent signs with, and carrying it twice would invite a reader to check the proof
 * against the copy rather than against the key they pinned. The hub relays a claim and
 * cannot mint one: the signature is over `did, sealingDid, at` by the signing key, which the
 * hub does not hold. See `signSealingKey` in `@quartet/identity`.
 */
export const sealingClaimSchema = z.object({
  sealingDid: z.string(),
  /** When the binding was signed. Covered by the proof, so it cannot be backdated after. */
  at: z.string(),
  proof: z.string(),
});
export type SealingClaim = z.infer<typeof sealingClaimSchema>;

/**
 * A member of a room, as the other members' bridges need them.
 *
 * Not an `Agent`: this is the roster, and a roster answers "who may read what I am about to
 * write". It carries the two keys and nothing else — no display name, no online flag, no
 * profile the app already has by other routes.
 *
 * It exists because a room can hold six and a connection holds two. `conversation.add`
 * spends the adder's connection, so a room's third member is somebody the second has never
 * been introduced to — and a bridge that could only resolve its own connections would seal
 * to a subset of the room without noticing. Sealing to a subset fails silently on the side
 * that was left out, which is the one direction this must never fail in.
 *
 * The sealing key is optional because a row can exist before a bridge has ever connected. A
 * member without one cannot be sealed to, and the bridge refuses to speak rather than writing
 * a line somebody in the room cannot open. The signing key is not optional — see below.
 */
export const memberSchema = z.object({
  handle: z.string(),
  /**
   * What they sign with, and what identifies them.
   *
   * Required, not optional: a member without a key is one nobody can name unambiguously,
   * seal to, or check a word from — and the store no longer holds an agent without one.
   */
  did: z.string(),
  sealing: sealingClaimSchema.optional(),
});
export type Member = z.infer<typeof memberSchema>;

export const conversationSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  /** Names the room in the list, and tells both agents what they are here to do. */
  purpose: z.string(),
  /**
   * Everyone in the room, in join order, including you.
   *
   * Members rather than handles because this list is also the recipient list: sealing a line
   * to a room means resolving every member's key, and a name is not a key.
   */
  participants: z.array(memberSchema),
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
   * The key that opened this room.
   *
   * Stored rather than read off `participants[0]`: whose turn it is to accept is a question
   * about consent, and reading it off an array's order would let adding a member change it.
   */
  proposedBy: z.string(),
  /** Keys whose agents have said goodbye and will not be woken by the room again. */
  bowedOut: z.array(z.string()),
  /** Keys who have asked to erase this room for everyone. It goes when all of them have. */
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
    /**
     * The key to seal this agent's copy to, signed by the did being proved above.
     *
     * Published on the handshake rather than through a frame of its own, because it is
     * identity material and this is the moment the hub has just watched the key it is signed
     * by answer a challenge. Required: a bridge with no sealing key cannot be spoken to
     * privately, and letting one connect anyway would leave every room it is in quietly
     * unable to seal.
     */
    sealing: sealingClaimSchema,
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
    /**
     * The key, not the name. A handle is what a person types; by the time a frame is built
     * the sender has already decided which key they meant, and sending anything else would
     * hand that decision back to the hub.
     */
    toDid: z.string(),
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
    /** The key, for the same reason `invite.send` names one. */
    did: z.string(),
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
    /**
     * The sealed line, opaque here.
     *
     * `MAX_SEALED_LENGTH` rather than `MAX_MESSAGE_LENGTH`: the hub bounds the blob it
     * stores and has no way to bound the words inside it. That ceiling moved to the bridge,
     * which is the only side that can still see them.
     */
    text: signable(MAX_SEALED_LENGTH),
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
