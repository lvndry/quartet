import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { RuntimeEvent, RuntimeInteraction } from "./types";
import { AcpRuntime } from "./acp-runtime";

const fixture = join(import.meta.dir, "acp-runtime.fixture.ts");
const live: AcpRuntime[] = [];

function runtime(overrides: Partial<ConstructorParameters<typeof AcpRuntime>[0]> = {}): AcpRuntime {
  const value = new AcpRuntime({
    command: process.execPath,
    args: [fixture],
    label: "Fixture",
    ...overrides,
  });
  live.push(value);
  return value;
}

function run(
  subject: AcpRuntime,
  conversationId: string,
  prompt: string,
  options: {
    signal?: AbortSignal;
    events?: RuntimeEvent[];
    interact?: (runId: string, pending: RuntimeInteraction) => Promise<{
      approved: boolean;
      response?: string;
    }>;
  } = {},
) {
  return subject.run({
    conversationId,
    prompt,
    signal: options.signal ?? new AbortController().signal,
    onEvent: (event) => options.events?.push(event),
    requestInteraction:
      options.interact ?? (async () => ({ approved: false })),
  });
}

afterEach(async () => {
  await Promise.all(live.splice(0).map((subject) => subject.close()));
});

describe("ACP runtime", () => {
  it("keeps one process and one ACP session per Quartet conversation", async () => {
    const subject = runtime();
    const first = await run(subject, "room-a", "first");
    const second = await run(subject, "room-a", "second");
    const other = await run(subject, "room-b", "other");

    expect(first).toMatchObject({ kind: "said", text: "session-1/1/none", cost: { costUSD: 0.25 } });
    expect(second).toMatchObject({ kind: "said", text: "session-1/2/none", cost: { costUSD: 0.25 } });
    expect(other).toMatchObject({ kind: "said", text: "session-2/1/none", cost: { costUSD: 0.25 } });
  });

  it("accumulates only assistant text and normalizes tool progress", async () => {
    const events: RuntimeEvent[] = [];
    const result = await run(runtime(), "room", "hello", { events });

    expect(result.kind === "said" ? result.text : "").not.toContain("secret thought");
    expect(events).toContainEqual({
      kind: "tool-started",
      toolName: "inspect",
      toolCallId: "tool-1",
      input: { path: "fixture" },
    });
    expect(events).toContainEqual({
      kind: "tool-finished",
      toolName: "inspect",
      toolCallId: "tool-1",
      ok: true,
      result: '{"found":true}',
    });
  });

  it("brokers permission without ever auto-approving", async () => {
    const events: RuntimeEvent[] = [];
    let pending: RuntimeInteraction | undefined;
    const result = await run(runtime(), "room", "FIXTURE_PERMISSION", {
      events,
      interact: async (_runId, interaction) => {
        pending = interaction;
        return { approved: true };
      },
    });

    expect(pending).toEqual({ kind: "approval", message: "Dangerous fixture action" });
    expect(events.some((event) => event.kind === "approval-required")).toBe(true);
    expect(result).toMatchObject({ kind: "said", text: "session-1/1/yes" });
  });

  it("sends session/cancel when the Quartet turn is aborted", async () => {
    const controller = new AbortController();
    const pending = run(runtime(), "room", "FIXTURE_CANCEL", { signal: controller.signal });
    await Bun.sleep(30);
    controller.abort();
    expect(await pending).toEqual({ kind: "failed", reason: "the ACP turn was cancelled" });
  });

  it("persists session ids and resumes them in a new process", async () => {
    const stored = new Map<string, string>();
    const hooks = {
      loadSession: (conversationId: string) => stored.get(conversationId),
      saveSession: (conversationId: string, sessionId: string) => {
        stored.set(conversationId, sessionId);
      },
    };
    const first = runtime(hooks);
    await run(first, "room", "one");
    await first.close();
    const second = runtime(hooks);
    const result = await run(second, "room", "two");
    expect(stored.get("room")).toBe("session-1");
    expect(result).toMatchObject({ kind: "said", text: "session-1/1/none" });
    expect(result.kind === "said" ? result.cost : undefined).toEqual({ incomplete: true });
  });

  it("reports process and malformed-protocol failures", async () => {
    const exited = await run(runtime(), "exit", "FIXTURE_EXIT");
    expect(exited).toMatchObject({ kind: "failed" });
    expect(exited.kind === "failed" ? exited.reason : "").toContain("code 17");

    const malformed = await run(runtime(), "bad", "FIXTURE_MALFORMED");
    expect(malformed).toMatchObject({ kind: "failed" });
    expect(malformed.kind === "failed" ? malformed.reason : "").toContain("ACP agent failed");
  });

  it("returns an unavailable executable as a turn failure", async () => {
    const result = await run(runtime({ command: "/quartet/does-not-exist", args: [] }), "room", "hello");
    expect(result).toMatchObject({ kind: "failed" });
    expect(result.kind === "failed" ? result.reason : "").toContain("ENOENT");
  });
});
