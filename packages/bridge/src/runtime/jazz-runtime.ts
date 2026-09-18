import type { DaemonSettings } from "../config";
import {
  answerParkedRun,
  createIdleWatchdog,
  MAX_PAYLOAD_BYTES,
  runTurn,
  TURN_TIMEOUT_MS,
  type TurnWatchdog,
} from "../jazz";
import type { RunTurnRequest, RuntimeOutcome, TurnRunner } from "./types";

/** Jazz implementation of the provider-neutral turn boundary. */
export class JazzRuntime implements TurnRunner {
  readonly info = {
    kind: "jazz" as const,
    label: "Jazz",
    maxPromptBytes: MAX_PAYLOAD_BYTES,
  };

  constructor(private readonly daemon: DaemonSettings) {}

  async run(request: RunTurnRequest): Promise<RuntimeOutcome> {
    const idle = createIdleWatchdog(TURN_TIMEOUT_MS);
    const signal = AbortSignal.any([idle.signal, request.signal]);
    const watchdog: TurnWatchdog = {
      signal,
      poke: idle.poke,
      dispose: idle.dispose,
      stats: idle.stats,
    };
    const channel = request.openEventChannel?.((event) => {
      idle.poke();
      request.onEvent(event);
    });

    let result;
    try {
      result = await runTurn(
        this.daemon,
        request.conversationId,
        request.prompt,
        watchdog,
        channel?.url,
      );
    } finally {
      channel?.close();
      idle.dispose();
    }

    // `runTurn` predates caller-driven cancellation and describes every abort using its idle
    // watchdog vocabulary. Keep that transport detail from leaking through the runtime seam.
    if (request.signal.aborted) return { kind: "failed", reason: "the Jazz turn was cancelled" };

    // A runtime may pause more than once in one turn. Keep those pauses inside the adapter:
    // to Bridge this remains one run with zero or more human interactions.
    while (result.kind === "needs-you") {
      const answer = await request.requestInteraction(
        result.runId,
        result.pending,
      );
      result = await answerParkedRun(
        this.daemon,
        result.runId,
        answer.approved,
        answer.note,
        answer.response,
      );
    }
    return result;
  }
}
