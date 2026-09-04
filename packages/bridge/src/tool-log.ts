/**
 * @fileoverview What your agent's current turn has actually done, tool call by tool call.
 *
 * The room's window into a running turn is one line — "your agent — grep" — which says a
 * tool started and never says what came back. This is the other half: a log the app can
 * show under that line, built from the same progress events.
 *
 * It never leaves this machine. `result` is output from this machine's disk, shell and
 * network, and the other side of a conversation has no business seeing it — what crosses
 * the wire stays what it always was, the tool's name. See `Bridge.onDaemonProgress`.
 */

/** One tool call, as this machine's daemon reported it. */
export interface ToolCall {
  /** The daemon's id for the call, or one made up here when it did not say. Pairs start with finish. */
  readonly id: string;
  readonly name: string;
  readonly state: "running" | "ok" | "failed" | "needs-you";
  /** What the call returned, clipped to `MAX_TOOL_RESULT_CHARS`. Local only. */
  readonly result?: string;
  /** Whether `result` is the whole of what came back, or where it was cut. */
  readonly clipped?: boolean;
  readonly at: number;
}

/**
 * What the daemon posts to the progress URL, as far as this bridge relies on it.
 *
 * Every field is `unknown` on purpose: this arrives over HTTP from a jazz that may be older
 * or newer than this bridge, so it is checked here rather than trusted from a shared type.
 */
export interface DaemonProgressEvent {
  readonly kind?: unknown;
  readonly toolName?: unknown;
  readonly toolCallId?: unknown;
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly resultTruncated?: unknown;
}

/**
 * How many tool calls one turn's log keeps.
 *
 * The bridge pushes its whole state to the browser on every change, and a turn that greps a
 * repository makes hundreds of calls — an uncapped log would make a status line the largest
 * thing on the socket. The oldest go first; the interesting end is the recent one.
 */
export const MAX_TOOL_LOG = 30;

/**
 * How much of one result the log keeps.
 *
 * The daemon hands over the result whole, deliberately, because clipping is the listener's
 * decision and not every listener wants a line. This listener does: the app shows these
 * under a one-line status, and thirty untrimmed results would be a megabyte of state pushed
 * over the socket on every tool call. The full result was never lost — it is in the answer
 * the turn is composing.
 */
export const MAX_TOOL_RESULT_CHARS = 240;

/**
 * This event, folded into the log it belongs to.
 *
 * Returns a new array rather than mutating, so the caller decides when the app sees it.
 */
export function recordToolCall(
  log: readonly ToolCall[],
  event: DaemonProgressEvent,
): readonly ToolCall[] {
  const name = text(event.toolName);
  if (name === undefined) return log;
  const callId = text(event.toolCallId);

  if (event.kind === "tool-started") {
    return capped([...log, { id: callId ?? crypto.randomUUID(), name, state: "running", at: Date.now() }]);
  }

  const settled: ToolCall = {
    id: callId ?? crypto.randomUUID(),
    name,
    state: event.kind === "approval-required" ? "needs-you" : event.ok === false ? "failed" : "ok",
    at: Date.now(),
    ...clip(text(event.result), event.resultTruncated === true),
  };

  // Matched on the daemon's own call id, so a turn that asks for four tools at once shows
  // four lines resolving independently rather than one line overwriting itself. A daemon too
  // old to send an id gets the newest still-running call of that name, which is right for the
  // serial case and no worse than the alternative for any other.
  const index = lastIndexOf(log, (call) =>
    callId !== undefined ? call.id === callId : call.name === name && call.state === "running",
  );
  // A finish with no start behind it is still worth showing: the log is what happened, not a
  // reconstruction of what should have.
  if (index === -1) return capped([...log, settled]);

  const started = log[index];
  const merged = [...log];
  merged[index] = { ...settled, at: started?.at ?? settled.at };
  return merged;
}

function lastIndexOf(log: readonly ToolCall[], matches: (call: ToolCall) => boolean): number {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const call = log[index];
    if (call !== undefined && matches(call)) return index;
  }
  return -1;
}

function clip(
  result: string | undefined,
  truncatedByDaemon: boolean,
): { result?: string; clipped?: boolean } {
  if (result === undefined) return {};
  if (result.length <= MAX_TOOL_RESULT_CHARS) {
    return truncatedByDaemon ? { result, clipped: true } : { result };
  }
  return { result: result.slice(0, MAX_TOOL_RESULT_CHARS), clipped: true };
}

function capped(log: readonly ToolCall[]): readonly ToolCall[] {
  return log.length > MAX_TOOL_LOG ? log.slice(log.length - MAX_TOOL_LOG) : log;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
