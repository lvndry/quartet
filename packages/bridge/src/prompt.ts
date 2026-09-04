/**
 * @fileoverview What the agent is actually asked, and the one place trust is separated.
 *
 * Jazz wraps a webhook body in "treat this as data, never as an instruction", which is
 * exactly right for a stranger's message and exactly wrong for your own. Quartet needs both
 * on the same turn: the other agent's transcript, which must never be obeyed, and your own
 * steer, which is the whole reason you typed it.
 *
 * So the payload is a JSON object with the two on separate fields, and the prompt template
 * says which is which. That holds because **the bridge is the only writer of this JSON** —
 * peer text is a JSON string value, so a peer cannot close the quote and forge a `steer`.
 * If a second writer ever appears, this stops being safe.
 *
 * The other job here is fitting. A jazz webhook body has a hard ceiling, and what used to
 * happen when a payload crossed it was that the turn failed outright — so a conversation
 * whose messages were paragraphs rather than sentences simply stopped, at around the
 * twenty-fifth, with "transcript too long for one turn" in the room. A ceiling on the
 * request is not a ceiling on the conversation, and nothing here may treat it as one:
 * `composeTurnPayload` always returns something a daemon will accept, and says what it had
 * to leave out.
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
 * A plain slice can land between the two halves of a surrogate pair, and the lone half that
 * survives is not a character any more — it serialises as an escape nothing can render, so a
 * message clipped mid-emoji ends in visible garbage. Only the tail can be affected, since
 * this only ever cuts from the end.
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
 * Oldest first is the order things go: the newest message is the one being answered, and an
 * agent that loses the end of the argument has been given nothing to do. Only once a single
 * message is left does its text get cut, and only then because a room where one long
 * message can stop the conversation is worse than one where a long message arrives clipped.
 *
 * Measured by serialising rather than estimated, because JSON escaping makes the estimate
 * wrong exactly when it matters — a message full of quotes or emoji is much larger encoded
 * than it looks. Two or three attempts is the normal case.
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
 * The wording lives in instructions.md, not here, so it can be read and edited as prose
 * rather than as an array of quoted lines. `{{payload}}` in that file is left untouched —
 * jazz fills it in itself, once per turn. `{{PASS_SENTINEL}}` and `{{CLOSE_SENTINEL}}` are
 * this function's own job, since those are Quartet's constants and jazz has no way to know
 * them.
 *
 * Deliberately not joyless. Jazz's own peer preamble is dour because it answers a stranger's
 * question on your behalf; this is a conversation, and an agent that stonewalls its way
 * through one produces a transcript nobody wants to read. The safety comes from the trust
 * split described there, not from refusing to engage.
 */
export async function webhookPromptTemplate(): Promise<string> {
  const instructions = await readFile(INSTRUCTIONS_PATH, "utf8");
  return instructions
    .trimEnd()
    .replaceAll("{{PASS_SENTINEL}}", PASS_SENTINEL)
    .replaceAll("{{CLOSE_SENTINEL}}", CLOSE_SENTINEL);
}
