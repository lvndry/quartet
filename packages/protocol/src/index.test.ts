import { describe, expect, it } from "bun:test";
import { describeFrameRejection, parseClientFrame } from "./index";

const AUTHORSHIP = { authoredAt: "2026-09-02T18:08:03.000Z", nonce: "n0", prev: "", signature: "s" };

describe("explaining a rejected frame", () => {
  it("names a frame this build has never heard of, and blames version skew", () => {
    const detail = describeFrameRejection({ t: "some.future.thing" });

    expect(detail).toContain('"some.future.thing"');
    expect(detail).toContain("different commits");
  });

  it("names the field when a known frame is malformed", () => {
    const detail = describeFrameRejection({
      t: "say",
      conversationId: "c1",
      dispatch: "dsp_00000001",
      text: "",
    });

    expect(detail).toContain('"say"');
    expect(detail).toContain("text");
  });

  it("refuses a turn result that names no dispatch", () => {
    // The hub checks that the dispatch is one it handed out; this is the earlier line, where
    // a frame without one is not a frame at all. Both matter: an agent speaks when it is
    // given the floor, so "which turn is this" is not an optional field.
    for (const frame of [
      { t: "say", conversationId: "c1", text: "hello", authorship: AUTHORSHIP },
      { t: "pass", conversationId: "c1", authorship: AUTHORSHIP },
      { t: "trouble", conversationId: "c1", reason: "the daemon died" },
      { t: "waiting", conversationId: "c1" },
      { t: "progress", conversationId: "c1" },
    ]) {
      expect(parseClientFrame(frame)).toBeUndefined();
      expect(describeFrameRejection(frame)).toContain("dispatch");
    }
  });

  it("lists what it does understand when there is no kind at all", () => {
    expect(describeFrameRejection({ conversationId: "c1" })).toContain("hello");
    expect(describeFrameRejection("not an object")).toContain("hello");
  });

  it("says so when the frame was actually fine", () => {
    const valid = { t: "waiting", conversationId: "c1", dispatch: "dsp_00000001" };

    expect(parseClientFrame(valid)).toBeDefined();
    expect(describeFrameRejection(valid)).toBe("frame is valid");
  });

  it("accepts a watch frame with or without a conversation", () => {
    expect(parseClientFrame({ t: "watch", conversationId: "c1" })).toBeDefined();
    expect(parseClientFrame({ t: "watch" })).toBeDefined();
  });

  it("names authorship as the thing missing when a line arrives unsigned", () => {
    const unsigned = { t: "pass", conversationId: "c1", dispatch: "dsp_00000001" };

    expect(parseClientFrame(unsigned)).toBeUndefined();
    expect(describeFrameRejection(unsigned)).toContain("authorship");
  });
});
