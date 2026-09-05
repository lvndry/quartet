/**
 * @fileoverview The wire, written down, so that changing it has to be deliberate.
 *
 * Everything else in this suite checks that a frame behaves correctly. This checks something
 * duller and easier to lose: that the set of frames is still the set of frames. Three
 * processes ship separately — your bridge, their bridge, somebody else's hub — so a frame
 * quietly renamed is not a failed test, it is two versions in the wild that cannot talk.
 *
 * Adding a frame or an optional field passes, because that is the compatible direction.
 * Renaming or removing one fails, and the fix is to update the list below in the same commit
 * — at which point the diff says "the wire changed", which is the whole point.
 *
 * The ceilings are here for the same reason. They are agreed on by parties who never
 * negotiate them: the hub refuses a frame over `MAX_SEALED_LENGTH` whether or not the bridge
 * that sent it thinks that is the number.
 */

import { describe, expect, test } from "bun:test";

import {
  clientFrameSchema,
  serverFrameSchema,
  limitSchema,
  DEFAULT_TURN_BUDGET,
  MAX_TURN_BUDGET,
  UNLIMITED_TURN_BUDGET,
  MAX_SPEND_USD,
  MAX_MESSAGE_LENGTH,
  MAX_SEALED_LENGTH,
  MAX_ROOM_MEMBERS,
  WELCOME_TRANSCRIPT_WINDOW,
  HISTORY_PAGE_SIZE,
  TURN_OVERLAP,
  TURN_SLICE_MAX,
  PASS_SENTINEL,
  CLOSE_SENTINEL,
} from "./index";

/** The discriminator values of a union, read off the schema rather than trusted from memory. */
function kindsOf(schema: { readonly options: readonly unknown[] }, key: string): string[] {
  return schema.options
    .map((option) => {
      const shape = (option as { shape?: Record<string, { value?: unknown }> }).shape;
      return shape?.[key]?.value;
    })
    .filter((value): value is string => typeof value === "string")
    .sort();
}

describe("the wire still has the frames it had", () => {
  test("bridge → hub", () => {
    expect(kindsOf(clientFrameSchema, "t")).toEqual(
      [
        "conversation.add",
        "conversation.delete",
        "conversation.leave",
        "conversation.open",
        "conversation.reopen",
        "conversation.respond",
        "conversation.stop",
        "directory.list",
        "hello",
        "history.load",
        "invite.respond",
        "invite.send",
        "limit.set",
        "nudge",
        "pass",
        "ping",
        "profile.set",
        "progress",
        "say",
        "trouble",
        "waiting",
        "watch",
      ].sort(),
    );
  });

  test("hub → bridge", () => {
    expect(kindsOf(serverFrameSchema, "t")).toEqual(
      [
        "appended",
        "budget",
        "challenge",
        "connected",
        "conversation",
        "conversation.removed",
        "directory",
        "error",
        "history",
        "invite",
        "presence",
        "pong",
        "turn",
        "welcome",
      ].sort(),
    );
  });

  test("a limit is one of three things", () => {
    expect(kindsOf(limitSchema, "kind")).toEqual(["cost", "none", "turns"]);
  });
});

describe("the numbers both ends agree on", () => {
  test("the ceilings are what they were", () => {
    expect({
      DEFAULT_TURN_BUDGET,
      MAX_TURN_BUDGET,
      UNLIMITED_TURN_BUDGET,
      MAX_SPEND_USD,
      MAX_MESSAGE_LENGTH,
      MAX_SEALED_LENGTH,
      MAX_ROOM_MEMBERS,
      WELCOME_TRANSCRIPT_WINDOW,
      HISTORY_PAGE_SIZE,
      TURN_OVERLAP,
      TURN_SLICE_MAX,
    }).toEqual({
      DEFAULT_TURN_BUDGET: 50,
      MAX_TURN_BUDGET: 500,
      UNLIMITED_TURN_BUDGET: 0,
      MAX_SPEND_USD: 1000,
      MAX_MESSAGE_LENGTH: 10_000,
      MAX_SEALED_LENGTH: 16_000,
      MAX_ROOM_MEMBERS: 6,
      WELCOME_TRANSCRIPT_WINDOW: 60,
      HISTORY_PAGE_SIZE: 60,
      TURN_OVERLAP: 6,
      TURN_SLICE_MAX: 100,
    });
  });

  test("a sealed line has room for a full one", () => {
    // Not arbitrary: base64 costs a third, and a full room adds a wrapped key per member.
    // If someone raises the message ceiling without raising this, the hub starts refusing
    // legitimate messages — and it would refuse them at the far end, not at the author's.
    expect(MAX_SEALED_LENGTH).toBeGreaterThan((MAX_MESSAGE_LENGTH * 4) / 3);
  });

  test("a welcome shows at least what the agent answered from", () => {
    // The app must never show less transcript than the model was given, or a person reading
    // the room cannot account for what it said.
    expect(WELCOME_TRANSCRIPT_WINDOW).toBeGreaterThanOrEqual(TURN_OVERLAP);
  });

  test("the sentinels are distinct and reserved", () => {
    // A pass is silence; a close is a goodbye that shuts the room. Collapsing them would end
    // conversations that meant to continue.
    expect(PASS_SENTINEL).not.toBe(CLOSE_SENTINEL);
  });
});
