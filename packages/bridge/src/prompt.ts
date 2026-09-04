/**
 * @fileoverview What the agent is actually asked, and the one place trust is separated.
 *
 * A turn carries two things that need opposite treatment: the other agent's transcript, which
 * must never be obeyed, and your own steer, which is the whole reason you typed it. So the
 * payload is a JSON object with the two on separate fields and the template says which is
 * which. **That holds only because the bridge is the sole writer of this JSON** — peer text
 * is a JSON string value, so a peer cannot close the quote and forge a `steer`.
 *
 * The other job is fitting. A ceiling on one request is not a ceiling on the conversation, so
 * `composeTurnPayload` always returns something a daemon will accept and says what it left
 * out — it used to fail the turn instead, and a room of paragraph-length messages simply
 * stopped at around the twenty-fifth.
 */

import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { CLOSE_SENTINEL, PASS_SENTINEL, type Message } from "@quartet/protocol";

/** One line of the room, as the agent sees it. */
export interface TranscriptLine {
  readonly from: string;
  readonly text: string;
  readonly at: string;
  /** Present when this message was cut to fit. The agent is told, rather than misled. */
  readonly truncated?: true;
}

export interface TurnPayload {
  readonly you: string;
  /** Everyone else in the room. A list, because a room is not necessarily a pair. */
  readonly speakingWith: readonly string[];
  readonly purpose: string;
  /**
   * How many earlier messages are not in `transcript`.
   *
   * Almost always ones this agent was sent in previous turns and still remembers, since
   * every turn resumes the same jazz conversation. Named so the agent can be told the room
   * did not start where its transcript does.
   */
  readonly earlierMessages?: number;
  readonly transcript: readonly TranscriptLine[];
  readonly steer?: string;
  readonly roomNotice?: string;
}

export interface ComposeInput {
  readonly you: string;
  readonly speakingWith: readonly string[];
  readonly purpose: string;
  readonly transcript: readonly Message[];
  /** How many messages precede `transcript` in the room, as the hub counted them. */
  readonly earlier: number;
  readonly steer?: string;
  readonly notice?: string;
}

export interface ComposedTurn {
  readonly payload: string;
  /** Messages the hub sent that would not fit, dropped oldest first. */
  readonly dropped: number;
  /** Messages kept but cut short. */
  readonly truncated: number;
}

/** A marker on a cut message, so the agent can see the sentence does not simply stop. */
const CUT_MARKER = " […cut to fit]";

/**
 * The shortest a cut message is worth keeping.
 *
 * Below this there is no message left, only the marker and a handle — which tells the agent
 * somebody spoke without telling it anything, and costs tokens to say so.
 */
const MIN_KEPT_CHARS = 200;

/**
 * Cut to a length in code units without leaving half a character behind.
 *
 * A plain slice can land between the halves of a surrogate pair, and a message clipped
 * mid-emoji ends in visible garbage. Only the tail is at risk, since this cuts from the end.
 */
function sliceWholeCharacters(text: string, end: number): string {
  const cut = text.slice(0, end);
  const last = cut.charCodeAt(cut.length - 1);
  const isUnpairedHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return isUnpairedHighSurrogate ? cut.slice(0, -1) : cut;
}

function render(input: ComposeInput, lines: readonly TranscriptLine[], dropped: number): string {
  const earlier = input.earlier + dropped;
  const payload: TurnPayload = {
    you: input.you,
    speakingWith: input.speakingWith,
    purpose: input.purpose,
    ...(earlier > 0 ? { earlierMessages: earlier } : {}),
    transcript: lines,
    ...(input.steer !== undefined ? { steer: input.steer } : {}),
    ...(input.notice !== undefined ? { roomNotice: input.notice } : {}),
  };
  return JSON.stringify(payload, null, 2);
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Build a turn payload that fits in `budgetBytes`, whatever it is given.
 *
 * Oldest goes first: the newest message is the one being answered. Text is only cut once a
 * single message is left, because a clipped message beats a stopped conversation.
 *
 * Measured by serialising rather than estimated: JSON escaping makes the estimate wrong
 * exactly when it matters. Two or three attempts is the normal case.
 */
export function composeTurnPayload(input: ComposeInput, budgetBytes: number): ComposedTurn {
  const all: TranscriptLine[] = input.transcript
    .filter((message) => message.kind === "agent")
    .map((message) => ({ from: message.authorHandle, text: message.text, at: message.at }));

  let lines = all;
  let dropped = 0;
  let payload = render(input, lines, dropped);
  while (bytes(payload) > budgetBytes && lines.length > 1) {
    lines = lines.slice(1);
    dropped += 1;
    payload = render(input, lines, dropped);
  }
  if (bytes(payload) <= budgetBytes) {
    return { payload, dropped, truncated: 0 };
  }

  // One message left and it still does not fit. Halving converges in a handful of rounds
  // and never overshoots into a payload that is bigger than the one before it.
  const only = lines[0];
  if (only !== undefined) {
    let text = only.text;
    while (text.length > MIN_KEPT_CHARS) {
      text = sliceWholeCharacters(text, Math.floor(text.length / 2));
      const cut: TranscriptLine = { ...only, text: text + CUT_MARKER, truncated: true };
      payload = render(input, [cut], dropped);
      if (bytes(payload) <= budgetBytes) return { payload, dropped, truncated: 1 };
    }
  }

  // Nothing from the room fits at all, which means the purpose and the steer have taken the
  // whole budget between them. Both are the operator's own words and capped where they are
  // set, so this is close to unreachable — but a turn with no transcript is still a turn the
  // agent can act on, and it is emphatically better than no turn.
  return { payload: render(input, [], dropped + lines.length), dropped: all.length, truncated: 0 };
}

const INSTRUCTIONS_PATH = join(dirname(Bun.fileURLToPath(import.meta.url)), "instructions.md");

/**
 * The template written into the operator's jazz config.
 *
 * The wording is in `instructions.md` so it can be read as prose. `{{payload}}` is left for
 * jazz to fill in; the sentinels are quartet's own constants and are substituted here.
 *
 * Deliberately not joyless: the safety comes from the trust split, not from stonewalling.
 */
export async function webhookPromptTemplate(): Promise<string> {
  const instructions = await readFile(INSTRUCTIONS_PATH, "utf8");
  return instructions
    .trimEnd()
    .replaceAll("{{PASS_SENTINEL}}", PASS_SENTINEL)
    .replaceAll("{{CLOSE_SENTINEL}}", CLOSE_SENTINEL);
}
