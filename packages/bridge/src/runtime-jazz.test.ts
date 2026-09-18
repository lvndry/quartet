import { afterEach, describe, expect, it, mock } from "bun:test";
import { JazzRuntime } from "./runtime/jazz-runtime";
import type { RunTurnRequest, RuntimeEvent } from "./runtime/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(overrides: Partial<RunTurnRequest> = {}): RunTurnRequest {
  return {
    conversationId: "room-1",
    prompt: '{"purpose":"test"}',
    signal: new AbortController().signal,
    onEvent: () => undefined,
    requestInteraction: async () => ({ approved: true }),
    ...overrides,
  };
}

describe("JazzRuntime", () => {
  it("advertises the prompt budget through the provider-neutral runner info", () => {
    const runtime = new JazzRuntime({
      url: "http://jazz.test",
      webhook: "quartet",
      webhookToken: "secret",
    });
    expect(runtime.info.kind).toBe("jazz");
    expect(runtime.info.label).toBe("Jazz");
    expect(runtime.info.maxPromptBytes).toBeGreaterThan(1_000);
  });

  it("runs a Jazz turn and supplies the external event callback", async () => {
    let receiver: ((event: RuntimeEvent) => void) | undefined;
    let closed = false;
    const seen: RuntimeEvent[] = [];
    globalThis.fetch = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("x-jazz-progress-url")).toBe(
          "http://local/progress/key",
        );
        receiver?.({ kind: "tool-started", toolName: "search" });
        return Response.json({ answer: "done", costUSD: 0.02 });
      },
    ) as unknown as typeof fetch;

    const runtime = new JazzRuntime({
      url: "http://jazz.test",
      webhook: "quartet",
      webhookToken: "secret",
    });
    const result = await runtime.run(
      request({
        onEvent: (event) => seen.push(event),
        openEventChannel: (receive) => {
          receiver = receive;
          return {
            url: "http://local/progress/key",
            close: () => {
              closed = true;
            },
          };
        },
      }),
    );

    expect(result.kind).toBe("said");
    expect(seen).toEqual([{ kind: "tool-started", toolName: "search" }]);
    expect(closed).toBe(true);
  });

  it("brokers a parked Jazz approval inside the same runtime turn", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/webhooks/quartet")) {
          return Response.json(
            {
              runId: "run-7",
              pending: { kind: "approval", message: "Use calendar?" },
            },
            { status: 202 },
          );
        }
        expect(JSON.parse(String(init?.body))).toEqual({
          approved: true,
          note: "go ahead",
        });
        return Response.json({ answer: "booked", costUSD: 0.01 });
      },
    ) as unknown as typeof fetch;

    const runtime = new JazzRuntime({
      url: "http://jazz.test",
      webhook: "quartet",
      webhookToken: "secret",
      daemonToken: "daemon-secret",
    });
    const interaction = mock(async (runId: string) => {
      expect(runId).toBe("run-7");
      return { approved: true, note: "go ahead" };
    });
    const result = await runtime.run(
      request({ requestInteraction: interaction }),
    );

    expect(interaction).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("said");
    expect(calls).toEqual([
      "http://jazz.test/webhooks/quartet",
      "http://jazz.test/runs/run-7/answer",
    ]);
  });
});
