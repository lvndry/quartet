import { describe, expect, it } from "bun:test";
import { CLOSE_SENTINEL, PASS_SENTINEL } from "@quartet/protocol";
import { interpretAnswer } from "./jazz";

const said = (answer: string) => interpretAnswer({ answer, costUSD: 0.01 });

describe("reading what an agent answered", () => {
  it("treats a bare pass as silence", () => {
    expect(said(PASS_SENTINEL).kind).toBe("passed");
    expect(said(`  ${PASS_SENTINEL}  `).kind).toBe("passed");
  });

  it("delivers a message that ends in a pass, sentinel and all", () => {
    // The instructions tell an agent facing something hard to state the problem and then
    // pass, so the room can answer it. Reading that as silence would delete the problem.
    const result = said(`Who has seen this failure before?\n\n${PASS_SENTINEL}`);
    expect(result.kind).toBe("said");
    if (result.kind === "said") {
      expect(result.text).toContain("Who has seen this failure before?");
      expect(result.text).toContain(PASS_SENTINEL);
      expect(result.closing).toBe(false);
    }
  });

  it("delivers a message that leads with a pass rather than deleting it", () => {
    // Misplaced, since the sentinels belong at the end — but a model that puts one first
    // used to have the rest of its turn silently discarded. Untidy beats lost.
    const result = said(`${PASS_SENTINEL} actually, one more thing worth saying.`);
    expect(result.kind).toBe("said");
    if (result.kind === "said") expect(result.text).toContain("one more thing");
  });

  it("keeps a goodbye in the message and still closes on it", () => {
    const result = said(`Good luck with it. ${CLOSE_SENTINEL}`);
    expect(result.kind).toBe("said");
    if (result.kind === "said") {
      expect(result.closing).toBe(true);
      expect(result.text).toContain(CLOSE_SENTINEL);
    }
  });

  it("closes on a bare goodbye instead of losing it as silence", () => {
    // A reply of nothing but the closing sentinel used to be read as a pass, which carries
    // no closing flag — so the agent said goodbye and the room stayed open.
    const result = said(CLOSE_SENTINEL);
    expect(result.kind).toBe("said");
    if (result.kind === "said") expect(result.closing).toBe(true);
  });

  it("fails an empty answer rather than calling it a pass", () => {
    // A model that produced nothing and a model that chose to say nothing are different
    // things, which is the whole reason the sentinel exists.
    expect(interpretAnswer({ answer: "" }).kind).toBe("failed");
    expect(interpretAnswer(null).kind).toBe("failed");
  });

  it("marks an unpriced turn rather than assuming it was free", () => {
    const result = interpretAnswer({ answer: "hello" });
    if (result.kind === "said") expect(result.cost.incomplete).toBe(true);
  });
});
