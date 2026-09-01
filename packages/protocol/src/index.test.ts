import { describe, expect, it } from "bun:test";
import { describeFrameRejection, parseClientFrame } from "./index";

describe("explaining a rejected frame", () => {
  it("names a frame this build has never heard of, and blames version skew", () => {
    const detail = describeFrameRejection({ t: "some.future.thing" });

    expect(detail).toContain('"some.future.thing"');
    expect(detail).toContain("different commits");
  });

  it("names the field when a known frame is malformed", () => {
    const detail = describeFrameRejection({ t: "say", conversationId: "c1", text: "" });

    expect(detail).toContain('"say"');
    expect(detail).toContain("text");
  });

  it("lists what it does understand when there is no kind at all", () => {
    expect(describeFrameRejection({ conversationId: "c1" })).toContain("hello");
    expect(describeFrameRejection("not an object")).toContain("hello");
  });

  it("says so when the frame was actually fine", () => {
    const valid = { t: "pass", conversationId: "c1" };

    expect(parseClientFrame(valid)).toBeDefined();
    expect(describeFrameRejection(valid)).toBe("frame is valid");
  });
});
