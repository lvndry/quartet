import type { HumanQuestion } from "@quartet/protocol";

/** Stable facts about an execution backend, used without knowing its protocol. */
export interface TurnRunnerInfo {
  readonly kind: "jazz" | "acp";
  readonly label: string;
  readonly maxPromptBytes: number;
}

export interface TurnCost {
  readonly costUSD?: number;
  readonly incomplete: boolean;
}

export type RuntimeOutcome =
  | {
      readonly kind: "said";
      readonly text: string;
      readonly cost: TurnCost;
      readonly closing: boolean;
    }
  | { readonly kind: "passed"; readonly cost: TurnCost }
  | { readonly kind: "failed"; readonly reason: string };

/** Progress is deliberately the small common vocabulary the Quartet UI understands. */
export interface RuntimeEvent {
  readonly kind?: unknown;
  readonly toolName?: unknown;
  readonly toolCallId?: unknown;
  readonly ok?: unknown;
  readonly input?: unknown;
  readonly result?: unknown;
  readonly resultTruncated?: unknown;
  readonly error?: unknown;
}

export type RuntimeInteraction =
  | { readonly kind: "approval"; readonly message?: string }
  | { readonly kind: "question"; readonly question: HumanQuestion };

export interface RuntimeInteractionAnswer {
  readonly approved: boolean;
  readonly note?: string;
  readonly response?: string;
}

export interface RuntimeEventChannel {
  readonly url?: string;
  readonly close: () => void;
}

export interface RunTurnRequest {
  readonly conversationId: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly onEvent: (event: RuntimeEvent) => void;
  /**
   * Gives runtimes which report out-of-process (Jazz) a one-turn callback. In-process
   * runtimes simply call `onEvent` and leave this unused.
   */
  readonly openEventChannel?: (
    receive: (event: RuntimeEvent) => void,
  ) => RuntimeEventChannel;
  readonly requestInteraction: (
    runId: string,
    pending: RuntimeInteraction,
  ) => Promise<RuntimeInteractionAnswer>;
}

/** The sole execution dependency of Bridge. */
export interface TurnRunner {
  readonly info: TurnRunnerInfo;
  run(request: RunTurnRequest): Promise<RuntimeOutcome>;
  close?(): void | Promise<void>;
}
