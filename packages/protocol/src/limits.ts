/**
 * @fileoverview The bounds, with nothing that parses.
 *
 * Split out of `index.ts` so the app can have the numbers without the validator. The hub wire
 * needs zod; the browser needs to know that a turn budget stops at 500 so a form can refuse
 * 501 before the hub does. Those are different needs, and folding them into one module put
 * zod's whole runtime in the page's bundle to deliver eleven integers.
 *
 * So: no zod here, and no imports at all. `index.ts` builds its schemas from these, and
 * `snapshot.ts` re-exports them through the app's door. Both get one definition of every
 * ceiling, which is the property that matters — a bound the form and the wire disagree about
 * is worse than no bound in the form.
 */

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
 *
 * Written as a type rather than inferred from the schema, because the schema lives on the
 * other side of the zod boundary. `index.ts` asserts at compile time that its `limitSchema`
 * still produces exactly this, so the two cannot drift in silence.
 */
export type Limit =
  | { readonly kind: "turns"; readonly turns: number }
  | { readonly kind: "cost"; readonly usd: number }
  | { readonly kind: "none" };

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
