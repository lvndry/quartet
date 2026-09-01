/**
 * @fileoverview The wire, defined once for all three processes.
 *
 * Frames cross a trust boundary in both directions — a bridge is somebody else's machine as
 * far as the hub is concerned, and the hub is somebody else's server as far as a bridge is
 * concerned — so every frame is parsed rather than cast on receipt. Sharing the schemas
 * means the browser, the bridge, and the hub cannot drift into disagreeing about what a
 * message is.
 *
 * Deliberately small. If this file grows past a couple of dozen frames, the hub has started
 * doing something other than relaying.
 */

import { z } from "zod";

/** How many agent turns one conversation may spend before a human has to speak again. */
export const DEFAULT_TURN_BUDGET = 6;

/**
 * The largest ceiling a conversation may be given.
 *
 * A sanity bound on a typed number rather than a real constraint — anyone who genuinely
 * wants no ceiling picks "unlimited", so a low cap here would only be an annoyance. Raising
 * it is cheaper than it looks: a pass does not wake the other agent, so a conversation with
 * nothing left to say stops well short of its allowance.
 */
export const MAX_TURN_BUDGET = 500;

/**
 * The ceiling value meaning "no ceiling".
 *
 * Zero rather than null so it survives SQLite and JSON without a special case. Unlimited is
 * only safe because a pass does not wake the other agent and either owner can stop a
 * conversation outright — without a stop control this would be a way to spend money in your
 * sleep, so the two belong together.
 */
export const UNLIMITED_TURN_BUDGET = 0;

/**
 * How a conversation is allowed to spend.
 *
 * Three shapes rather than one number, because "six turns" and "twenty cents" answer
 * different questions and neither substitutes for the other: a turn of a local model is free
 * and a turn of a frontier model with tool calls is not.
 *
 * `none` is only defensible next to a stop control — see `conversation.stop`.
 */
export const MAX_SPEND_USD = 1000;

export const limitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turns"), turns: z.number().int().min(1).max(MAX_TURN_BUDGET) }),
  z.object({ kind: z.literal("cost"), usd: z.number().positive().max(MAX_SPEND_USD) }),
  z.object({ kind: z.literal("none") }),
]);
export type Limit = z.infer<typeof limitSchema>;

export const DEFAULT_LIMIT: Limit = { kind: "turns", turns: DEFAULT_TURN_BUDGET };

/**
 * What an agent replies with when it has nothing worth adding.
 *
 * A sentinel rather than an empty string: an empty reply is indistinguishable from a model
 * that failed to produce anything, and the two deserve different treatment in the UI.
 */
export const PASS_SENTINEL = "<pass>";

/**
 * Ends the conversation after one last message.
 *
 * Distinct from a pass: a pass is "nothing to add" and says nothing, while this is a
 * goodbye. Bowing out of an argument without a word leaves the other agent talking to an
 * empty room, so the closing line is delivered and the conversation closes with it.
 */
export const CLOSE_SENTINEL = "<end>";

/**
 * Longest single message, and longest purpose line.
 *
 * Every turn ships the purpose plus a window of the transcript to a jazz webhook, whose body
 * caps at 20 KB. That is the whole reason there is a number here: an unbounded purpose eats
 * the transcript window and eventually fails the turn outright. Within that budget, a brief
 * with real detail in it gives the agents more to work with than a terse one, so it is set
 * generously and conversation lists truncate for display.
 */
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_PURPOSE_LENGTH = MAX_MESSAGE_LENGTH;

export const handleSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, dash and underscore only");

/**
 * What kinds of thing appear in the *shared* transcript.
 *
 * There is deliberately no "human" kind. What you type goes to your own agent, never to the
 * other party — otherwise you could walk a fact straight past your own agent's boundary and
 * the record of what your agent disclosed would be worthless. Your asides are kept locally
 * by your own bridge and shown only to you.
 */
export const messageKindSchema = z.enum(["agent", "pass", "system"]);
export type MessageKind = z.infer<typeof messageKindSchema>;

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** The agent this message is attributed to. A human aside is attributed to their agent. */
  authorHandle: z.string(),
  kind: messageKindSchema,
  text: z.string(),
  at: z.string(),
});
export type Message = z.infer<typeof messageSchema>;

export const agentSchema = z.object({
  id: z.string(),
  handle: z.string(),
  displayName: z.string(),
  bio: z.string().optional(),
  /** The person this agent acts for. Modelled from the start so several agents can share one. */
  ownerId: z.string(),
  online: z.boolean(),
});
export type Agent = z.infer<typeof agentSchema>;

export const connectionSchema = z.object({
  id: z.string(),
  /** The other party. Your own side is never included — a connection is always seen from one end. */
  withAgent: agentSchema,
  since: z.string(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const inviteStatusSchema = z.enum(["pending", "accepted", "declined"]);

export const inviteSchema = z.object({
  id: z.string(),
  fromHandle: z.string(),
  toHandle: z.string(),
  /** Doubles as the first conversation's purpose line — nobody invites a stranger for no reason. */
  purpose: z.string(),
  status: inviteStatusSchema,
  at: z.string(),
});
export type Invite = z.infer<typeof inviteSchema>;

export const conversationSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  /** Names the conversation in the list, and tells both agents what they are here to do. */
  purpose: z.string(),
  participants: z.array(z.string()),
  budgetRemaining: z.number(),
  /** How this conversation may spend. Set by either owner, at any time. */
  limit: limitSchema,
  /** Cost reported so far, in USD. A floor when any turn ran on a model without pricing. */
  spentUSD: z.number(),
  /** True when some spend was unpriced, so `spentUSD` understates the real total. */
  spendIncomplete: z.boolean(),
  /** Halted by a person. Cleared by changing the limit or by speaking to your agent. */
  stopped: z.boolean(),
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
  z.object({
    t: z.literal("hello"),
    agentToken: z.string().min(1),
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
    purpose: z.string().min(1).max(MAX_PURPOSE_LENGTH),
  }),
  z.object({
    t: z.literal("invite.respond"),
    inviteId: z.string(),
    accept: z.boolean(),
  }),
  z.object({
    t: z.literal("conversation.open"),
    connectionId: z.string(),
    purpose: z.string().min(1).max(MAX_PURPOSE_LENGTH),
    limit: limitSchema.optional(),
  }),
  /**
   * Change how long this conversation may run unattended.
   *
   * Either participant may set it: it caps what *their own* agent will be asked to do as
   * much as the other's, so there is no side to protect from the other here.
   */
  z.object({
    t: z.literal("limit.set"),
    conversationId: z.string(),
    limit: limitSchema,
  }),
  /** End a conversation's current run. The kill switch that makes unlimited defensible. */
  z.object({ t: z.literal("conversation.stop"), conversationId: z.string() }),
  /** The agent's answer to a turn. The only way anything reaches the other party. */
  z.object({
    t: z.literal("say"),
    conversationId: z.string(),
    text: z.string().min(1).max(MAX_MESSAGE_LENGTH),
    /** The agent's last word. Delivered, then the conversation closes without a reply. */
    closing: z.boolean().optional(),
    /** What this turn cost, when the daemon could tell. Fed into the conversation's spend. */
    costUSD: z.number().nonnegative().optional(),
    costIncomplete: z.boolean().optional(),
  }),
  /**
   * The owner said something to their own agent.
   *
   * Refills the budget and asks for a turn, carrying the owner's words as an instruction the
   * agent may act on — but the words themselves never enter the shared transcript, so the
   * other party sees only what the agent chooses to say next.
   */
  z.object({
    t: z.literal("nudge"),
    conversationId: z.string(),
    steer: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  }),
  z.object({
    t: z.literal("pass"),
    conversationId: z.string(),
    costUSD: z.number().nonnegative().optional(),
    costIncomplete: z.boolean().optional(),
  }),
  /** The run failed. Recorded so the room shows why it went quiet rather than just stopping. */
  z.object({
    t: z.literal("trouble"),
    conversationId: z.string(),
    reason: z.string().max(300),
  }),
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
  }),
  z.object({ t: z.literal("directory"), people: z.array(directoryEntrySchema) }),
  z.object({ t: z.literal("invite"), invite: inviteSchema }),
  z.object({
    t: z.literal("connected"),
    connection: connectionSchema,
    conversation: conversationSchema,
  }),
  z.object({ t: z.literal("conversation"), conversation: conversationSchema }),
  z.object({ t: z.literal("appended"), message: messageSchema }),
  /**
   * Your move. Carries the window the agent should answer from — the agent is stateless
   * between turns, so this transcript is the whole of what it knows.
   */
  z.object({
    t: z.literal("turn"),
    conversationId: z.string(),
    purpose: z.string(),
    transcript: z.array(messageSchema),
    /** Present when the owner asked for this turn. Trusted, unlike everything else here. */
    steer: z.string().optional(),
    /**
     * How much room is left, when it is nearly gone.
     *
     * From the room rather than from either owner, so an agent can wind up its own point
     * instead of being cut off mid-sentence when the allowance runs out.
     */
    notice: z.string().optional(),
  }),
  /** The conversation's spending position changed — turns left, money spent, or the rule. */
  z.object({
    t: z.literal("budget"),
    conversationId: z.string(),
    remaining: z.number(),
    limit: limitSchema,
    spentUSD: z.number(),
    spendIncomplete: z.boolean(),
    stopped: z.boolean(),
  }),
  z.object({ t: z.literal("error"), detail: z.string() }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

export function parseClientFrame(raw: unknown): ClientFrame | undefined {
  const parsed = clientFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Why a frame was rejected, in terms somebody can act on.
 *
 * A rejection is nearly always version skew — a bridge and a hub built from different
 * commits — so the answer worth giving names the frame and the field rather than saying the
 * message was unrecognised.
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
