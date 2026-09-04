import { describe, expect, it } from "bun:test";
import {
  MAX_TOOL_LOG,
  MAX_TOOL_RESULT_CHARS,
  recordToolCall,
  type DaemonProgressEvent,
  type ToolCall,
} from "./tool-log";

function log(...events: DaemonProgressEvent[]): readonly ToolCall[] {
  return events.reduce<readonly ToolCall[]>((sofar, event) => recordToolCall(sofar, event), []);
}

describe("a turn's tool log", () => {
  it("shows a call as running until the daemon says it finished", () => {
    const running = log({ kind: "tool-started", toolName: "grep", toolCallId: "c1" });
    expect(running).toMatchObject([{ name: "grep", state: "running" }]);

    const done = recordToolCall(running, {
      kind: "tool-finished",
      toolName: "grep",
      toolCallId: "c1",
      ok: true,
      result: "12 matches",
    });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ name: "grep", state: "ok", result: "12 matches" });
  });

  it("keeps the started-at of the call it settles, so the log does not reshuffle", () => {
    const running = log({ kind: "tool-started", toolName: "grep", toolCallId: "c1" });
    const startedAt = running[0]?.at;
    const done = recordToolCall(running, {
      kind: "tool-finished",
      toolName: "grep",
      toolCallId: "c1",
      ok: true,
    });
    expect(done[0]?.at).toBe(startedAt as number);
  });

  it("settles four parallel calls independently, by the daemon's own ids", () => {
    // A turn that asks for four tools at once used to be one line overwriting itself.
    const started = log(
      { kind: "tool-started", toolName: "read_file", toolCallId: "c1" },
      { kind: "tool-started", toolName: "read_file", toolCallId: "c2" },
      { kind: "tool-started", toolName: "search_web", toolCallId: "c3" },
    );
    const settled = recordToolCall(started, {
      kind: "tool-finished",
      toolName: "read_file",
      toolCallId: "c2",
      ok: false,
    });
    expect(settled.map((call) => call.state)).toEqual(["running", "failed", "running"]);
  });

  it("settles the newest running call of that name when the daemon sends no id", () => {
    const started = log(
      { kind: "tool-started", toolName: "grep" },
      { kind: "tool-started", toolName: "grep" },
    );
    const settled = recordToolCall(started, { kind: "tool-finished", toolName: "grep", ok: true });
    expect(settled.map((call) => call.state)).toEqual(["running", "ok"]);
  });

  it("records a finish it never saw start, rather than dropping it", () => {
    const settled = log({ kind: "tool-finished", toolName: "grep", toolCallId: "c9", ok: true });
    expect(settled).toMatchObject([{ name: "grep", state: "ok" }]);
  });

  it("marks a parked call as needing you", () => {
    const parked = log(
      { kind: "tool-started", toolName: "execute_command", toolCallId: "c1" },
      { kind: "approval-required", toolName: "execute_command", toolCallId: "c1" },
    );
    expect(parked).toMatchObject([{ state: "needs-you" }]);
  });

  it("clips a long result and says that it did", () => {
    const settled = log({
      kind: "tool-finished",
      toolName: "read_file",
      toolCallId: "c1",
      ok: true,
      result: "x".repeat(MAX_TOOL_RESULT_CHARS * 4),
    });
    expect(settled[0]?.result).toHaveLength(MAX_TOOL_RESULT_CHARS);
    expect(settled[0]?.clipped).toBe(true);
  });

  it("passes on that the daemon had already cut a result at its own ceiling", () => {
    const settled = log({
      kind: "tool-finished",
      toolName: "read_file",
      toolCallId: "c1",
      ok: true,
      result: "short",
      resultTruncated: true,
    });
    expect(settled[0]).toMatchObject({ result: "short", clipped: true });
  });

  it("keeps the recent end of a chatty turn and no more", () => {
    const chatty = log(
      ...Array.from({ length: MAX_TOOL_LOG * 3 }, (_unused, index) => ({
        kind: "tool-started",
        toolName: `tool_${index}`,
        toolCallId: `c${index}`,
      })),
    );
    expect(chatty).toHaveLength(MAX_TOOL_LOG);
    expect(chatty[chatty.length - 1]?.name).toBe(`tool_${MAX_TOOL_LOG * 3 - 1}`);
  });

  it("ignores an event with no tool name in it", () => {
    expect(log({ kind: "tool-started" }, { kind: "tool-started", toolName: 7 })).toEqual([]);
  });
});
