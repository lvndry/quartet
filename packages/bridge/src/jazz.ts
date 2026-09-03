/**
 * @fileoverview Talking to the jazz daemon on this machine, and setting it up to be talked to.
 *
 * Quartet drives `POST /webhooks/<name>` with `conversation: "threaded"`, so the agent
 * remembers the exchange across turns. One conversation is one thread key, keeping last
 * week's invoice thread out of today's dinner plans.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { CLOSE_SENTINEL, PASS_SENTINEL } from "@quartet/protocol";
import type { DaemonSettings } from "./config";
import { webhookPromptTemplate } from "./prompt";

/** What a turn cost, when the daemon could tell. `incomplete` means the figure is a floor. */
export interface TurnCost {
  readonly costUSD?: number;
  readonly incomplete: boolean;
}

export interface HumanQuestion {
  readonly question: string;
  readonly suggestions: readonly { readonly value: string; readonly label?: string; readonly description?: string }[];
  readonly allowCustom: boolean;
  readonly allowMultiple: boolean;
}

export type TurnResult =
  | {
      readonly kind: "said";
      readonly text: string;
      readonly cost: TurnCost;
      /** The agent's last word: delivered, then the conversation closes. */
      readonly closing: boolean;
    }
  | { readonly kind: "passed"; readonly cost: TurnCost }
  | { readonly kind: "needs-you"; readonly runId: string; readonly pending: { readonly kind: "approval"; readonly message?: string } | { readonly kind: "question"; readonly question: HumanQuestion } }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Cap chosen to sit under jazz's own 20 KB body limit with room for the JSON envelope.
 *
 * Exported because it is the budget `composeTurnPayload` builds to. It is a property of the
 * local daemon, which is why the bridge decides what fits rather than the hub: the hub does
 * not know what anybody's jazz will accept, and for a while the only thing the bridge could
 * do about an oversized payload was kill the turn.
 */
export const MAX_PAYLOAD_BYTES = 18_000;

/**
 * How long the daemon can go without reporting progress before a turn gives up on it.
 *
 * Bun's `fetch` gives up at five minutes by default, and a fixed deadline on top of that has
 * the same problem one level up: a turn that reads a calendar, searches the web and writes a
 * file can legitimately run long, and a wall-clock cap either has to be too short for that or
 * too long to catch a daemon that is actually wedged. Neither number is right, because the
 * question a fixed deadline can't answer is "is it still working?".
 *
 * The progress heartbeat already answers that: `createIdleWatchdog` below re-arms this
 * deadline on every progress event, so a turn that keeps reporting tool use never trips it,
 * no matter how long it runs. Only real silence — no progress at all for this long — ends the
 * turn. Half an hour, because that is a long time for the daemon to go quiet while genuinely
 * healthy.
 */
export const TURN_TIMEOUT_MS = 30 * 60_000;

/**
 * An abort signal that fires after `idleMs` of silence, not before — `poke()` pushes the
 * deadline out again each time it is called, so a caller that keeps hearing from the daemon
 * can keep a turn alive indefinitely while one that goes quiet still gets bounded.
 */
export function createIdleWatchdog(idleMs: number): {
  readonly signal: AbortSignal;
  readonly poke: () => void;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    }, idleMs);
  };
  arm();
  return { signal: controller.signal, poke: arm, dispose: () => clearTimeout(timer) };
}

/**
 * Whether this is the request giving up rather than the daemon being absent.
 *
 * Worth separating because they need opposite things said. "Not reachable" sends somebody
 * to check whether jazz is running; a timeout means it is running and probably still
 * working, and the useful next step is `jazz runs`.
 */
function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Header jazz reads a loopback progress URL from. Must match its own constant.
 *
 * No companion subscription header, deliberately. Jazz narrows to named event kinds when
 * asked and sends everything when not, and everything is what quartet wants: a room is the
 * one place a person is watching a turn, so anything the daemon can say about one belongs
 * here. Naming kinds would also pin this to the list jazz sends today and quietly opt out
 * of any it learns to send later.
 */
const PROGRESS_HEADER = "x-jazz-progress-url";

export async function runTurn(
  daemon: DaemonSettings,
  threadKey: string,
  payload: string,
  /**
   * From `createIdleWatchdog` — the caller owns arming it, poking it on progress, and
   * disposing it, since only the caller sees the progress events that should keep it alive.
   */
  signal: AbortSignal,
  /**
   * Where this machine's daemon should report what the run is doing.
   *
   * Optional because a jazz without the route ignores it, and because a turn is perfectly
   * valid without progress — it is just silent.
   */
  progressUrl?: string,
): Promise<TurnResult> {
  // Should be unreachable: every payload quartet sends is composed to this budget. Kept as
  // a guard for any future caller that builds one another way, because the alternative is
  // jazz rejecting it and the room being told nothing useful about why.
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    return { kind: "failed", reason: "the turn payload was too large for the daemon" };
  }

  let response: Response;
  try {
    response = await fetch(`${daemon.url}/webhooks/${encodeURIComponent(daemon.webhook)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
        "x-jazz-thread": threadKey,
        ...(progressUrl !== undefined ? { [PROGRESS_HEADER]: progressUrl } : {}),
      },
      body: payload,
      signal,
    });
  } catch (error) {
    if (isTimeout(error)) {
      return {
        kind: "failed",
        reason:
          `the daemon has gone quiet for ${String(Math.round(TURN_TIMEOUT_MS / 60_000))}m with no ` +
          "progress — the run may still be going; check `jazz runs`",
      };
    }
    return { kind: "failed", reason: "jazz daemon is not reachable — is `jazz daemon` running?" };
  }

  // A parked run is not a failure: the agent wanted to use a tool that needs a human, and
  // jazz is holding it open. Surfacing it as such is the difference between "your agent is
  // waiting for you" and "something broke".
  if (response.status === 202) {
    const parked = (await response.json().catch(() => null)) as
      | {
          runId?: string;
          pending?: {
            kind?: string;
            message?: string;
            question?: string;
            suggestions?: HumanQuestion["suggestions"];
            allowCustom?: boolean;
            allowMultiple?: boolean;
          };
        }
      | null;
    const pending = parked?.pending;
    if (pending?.kind === "question" && typeof pending.question === "string") {
      return {
        kind: "needs-you",
        runId: parked?.runId ?? "unknown",
        pending: {
          kind: "question",
          question: {
            question: pending.question,
            suggestions: pending.suggestions ?? [],
            allowCustom: pending.allowCustom === true,
            allowMultiple: pending.allowMultiple === true,
          },
        },
      };
    }
    return {
      kind: "needs-you",
      runId: parked?.runId ?? "unknown",
      pending: { kind: "approval", ...(typeof pending?.message === "string" ? { message: pending.message } : {}) },
    };
  }

  if (response.status === 404) {
    return {
      kind: "failed",
      reason:
        `jazz has no webhook called "${daemon.webhook}" — check the "webhooks" list in ` +
        `~/.jazz/config.json`,
    };
  }

  if (response.status === 401) {
    return {
      kind: "failed",
      reason:
        `jazz rejected the token for "${daemon.webhook}" — regenerate it with ` +
        `\`jazz webhook token ${daemon.webhook}\``,
    };
  }

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    return {
      kind: "failed",
      reason: detail?.error ?? `jazz answered ${String(response.status)}`,
    };
  }

  const body = (await response.json().catch(() => null)) as
    | { answer?: string; costUSD?: number; costIncomplete?: boolean }
    | null;
  return interpretAnswer(body);
}

/**
 * Resume a parked jazz run after the operator approved or declined a tool.
 *
 * Same door `jazz runs answer` uses: the daemon finishes the run and returns the text.
 */
export async function answerParkedRun(
  daemon: DaemonSettings,
  runId: string,
  approved: boolean,
  note?: string,
  questionResponse?: string,
): Promise<TurnResult> {
  let response: Response;
  try {
    response = await fetch(`${daemon.url}/runs/${encodeURIComponent(runId)}/answer`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        approved,
        ...(note !== undefined ? { note } : {}),
        ...(questionResponse !== undefined ? { response: questionResponse } : {}),
      }),
    });
  } catch {
    return { kind: "failed", reason: "jazz daemon is not reachable — is `jazz daemon` running?" };
  }

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    return {
      kind: "failed",
      reason: detail?.error ?? `jazz answered ${String(response.status)}`,
    };
  }

  const body = (await response.json().catch(() => null)) as
    | { answer?: string; costUSD?: number; costIncomplete?: boolean }
    | null;
  return interpretAnswer(body);
}

function interpretAnswer(
  body: { answer?: string; costUSD?: number; costIncomplete?: boolean } | null,
): TurnResult {
  const answer = body?.answer?.trim() ?? "";
  // An unpriced run is marked rather than assumed free: a local model reports no cost, and
  // treating that as zero would let a spend ceiling sit at zero forever.
  const cost: TurnCost = {
    ...(typeof body?.costUSD === "number" ? { costUSD: body.costUSD } : {}),
    incomplete: body?.costIncomplete === true || typeof body?.costUSD !== "number",
  };
  if (answer.length === 0) return { kind: "failed", reason: "jazz returned an empty answer" };
  if (answer === PASS_SENTINEL || answer.startsWith(PASS_SENTINEL)) return { kind: "passed", cost };

  const closing = answer.includes(CLOSE_SENTINEL);
  const text = answer.split(CLOSE_SENTINEL).join("").trim();
  if (text.length === 0) return { kind: "passed", cost };
  return { kind: "said", text, cost, closing };
}

/** Whether jazz's config actually lists this webhook, checked without running the agent. */
export async function webhookConfigured(webhookName: string): Promise<boolean> {
  const file = Bun.file(jazzConfigPath());
  if (!(await file.exists())) return false;
  const config = (await file.json().catch(() => ({}))) as { webhooks?: { name?: string }[] };
  return (
    Array.isArray(config.webhooks) &&
    config.webhooks.some((webhook) => webhook.name === webhookName)
  );
}

export async function daemonReachable(daemon: DaemonSettings): Promise<boolean> {
  try {
    const response = await fetch(`${daemon.url}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

interface JazzWebhookEntry {
  name: string;
  agentId: string;
  promptTemplate: string;
  conversation?: string;
  description?: string;
}

export function jazzConfigPath(): string {
  return join(process.env["JAZZ_HOME"] ?? join(homedir(), ".jazz"), "config.json");
}

/**
 * Which jazz agent a webhook wakes, according to jazz's own config.
 *
 * The answer to "which agent represents me" lives here rather than in quartet's config,
 * because the webhook entry is the thing that actually decides it. Two copies would be one
 * copy and a lie.
 */
export async function agentIdFor(webhookName: string): Promise<string | undefined> {
  const file = Bun.file(jazzConfigPath());
  if (!(await file.exists())) return undefined;
  const config = (await file.json().catch(() => ({}))) as {
    webhooks?: { name?: string; agentId?: string }[];
  };
  const entry = config.webhooks?.find((webhook) => webhook.name === webhookName);
  const agentId = entry?.agentId;
  return typeof agentId === "string" && agentId.length > 0 ? agentId : undefined;
}

/**
 * Add quartet's webhook to the operator's jazz config, leaving everything else alone.
 *
 * Merges one entry into `webhooks` by name and touches nothing else. The token stays in the
 * keyring, where jazz looks for it.
 */
export async function ensureJazzWebhook(input: {
  webhookName: string;
  agentId: string;
}): Promise<{ changed: boolean; path: string }> {
  const path = jazzConfigPath();
  const file = Bun.file(path);
  const config = ((await file.exists()) ? await file.json().catch(() => ({})) : {}) as {
    webhooks?: JazzWebhookEntry[];
  };

  const entry: JazzWebhookEntry = {
    name: input.webhookName,
    agentId: input.agentId,
    conversation: "threaded",
    promptTemplate: await webhookPromptTemplate(),
    description: "quartet — one turn in a conversation with another person's agent",
  };

  const existing = Array.isArray(config.webhooks) ? config.webhooks : [];
  const index = existing.findIndex((webhook) => webhook.name === input.webhookName);
  const already =
    index !== -1 &&
    existing[index]?.agentId === entry.agentId &&
    existing[index]?.conversation === entry.conversation &&
    existing[index]?.promptTemplate === entry.promptTemplate;
  if (already) return { changed: false, path };

  const webhooks =
    index === -1 ? [...existing, entry] : existing.map((existingEntry, position) =>
      position === index ? entry : existingEntry,
    );
  await Bun.write(path, `${JSON.stringify({ ...config, webhooks }, null, 2)}\n`);
  return { changed: true, path };
}

/** The environment variable jazz reads a webhook's token from when there is no keyring. */
export function webhookTokenEnvVar(webhookName: string): string {
  return `JAZZ_WEBHOOK_TOKEN_${webhookName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
