/**
 * @fileoverview Talking to the jazz daemon on this machine, and setting it up to be talked to.
 *
 * Quartet drives `POST /webhooks/<name>` with `conversation: "threaded"`, so the agent
 * remembers the exchange across turns. One conversation is one thread key, keeping last
 * week's invoice thread out of today's dinner plans.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { CLOSE_SENTINEL, PASS_SENTINEL, type HumanQuestion } from "@quartet/protocol";
import type { DaemonSettings } from "./config";
import { logger } from "./log";
import { webhookPromptTemplate } from "./prompt";

const log = logger("daemon");

/** What a turn cost, when the daemon could tell. `incomplete` means the figure is a floor. */
export interface TurnCost {
  readonly costUSD?: number;
  readonly incomplete: boolean;
}

// Defined in the protocol package because the app renders it. Re-exported so this module
// stays the one place the bridge reaches for anything about a jazz turn.
export type { HumanQuestion };

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
 * Under jazz's own 20 KB body limit, with room for the JSON envelope.
 *
 * A property of the local daemon, which is why the bridge decides what fits rather than the
 * hub: the hub does not know what anybody's jazz will accept.
 */
export const MAX_PAYLOAD_BYTES = 18_000;

/**
 * How long the daemon can go without reporting progress before a turn gives up on it.
 *
 * Idle rather than wall-clock, because a fixed cap cannot answer "is it still working?": a
 * turn that reads a calendar and searches the web runs long legitimately, so any number is
 * either too short for that or too long to catch a wedged daemon. `createIdleWatchdog` re-arms
 * this on every progress event, so only real silence ends a turn.
 *
 * Bun's `fetch` gives up at five minutes by default — measured at 300.08s against a server
 * that accepts and never answers — so `runTurn` turns that off and this is the only deadline
 * left.
 */
export const TURN_TIMEOUT_MS = 30 * 60_000;

/**
 * What the watchdog saw, for a log line that has to explain why a turn ended.
 *
 * Together these separate "never said anything at all" from "was working and then stopped",
 * which need different answers.
 */
export interface WatchdogStats {
  readonly pokes: number;
  readonly quietMs: number;
}

/**
 * An abort signal that fires after `idleMs` of silence, not before — `poke()` pushes the
 * deadline out again each time it is called, so a caller that keeps hearing from the daemon
 * can keep a turn alive indefinitely while one that goes quiet still gets bounded.
 */
export interface TurnWatchdog {
  readonly signal: AbortSignal;
  readonly poke: () => void;
  readonly dispose: () => void;
  readonly stats: () => WatchdogStats;
}

export function createIdleWatchdog(idleMs: number): TurnWatchdog {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let pokes = 0;
  let lastArmedAt = Date.now();
  const arm = (): void => {
    clearTimeout(timer);
    lastArmedAt = Date.now();
    timer = setTimeout(() => {
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    }, idleMs);
  };
  arm();
  return {
    signal: controller.signal,
    poke: () => {
      pokes += 1;
      arm();
    },
    dispose: () => {
      clearTimeout(timer);
    },
    stats: () => ({ pokes, quietMs: Date.now() - lastArmedAt }),
  };
}

/**
 * Whether this is the request giving up rather than the daemon being absent.
 *
 * They need opposite things said: one sends somebody to check whether jazz is running, the
 * other means it is running and `jazz runs` is the next step. Says nothing about *whose*
 * timeout — see the catch in `runTurn`.
 */
function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Everything an error will admit to, flattened into log fields.
 *
 * The part that identifies what broke is routinely one level down in `cause`; the top-level
 * message is often just "fetch failed".
 */
function describeError(error: unknown): Record<string, string | undefined> {
  const thrown = error instanceof Error ? error : undefined;
  const cause = thrown?.cause;
  const causeError = cause instanceof Error ? cause : undefined;
  const code = (error as { code?: unknown } | null)?.code;
  return {
    err: thrown === undefined ? String(error) : `${thrown.name}: ${thrown.message}`,
    code: typeof code === "string" || typeof code === "number" ? String(code) : undefined,
    cause:
      causeError !== undefined
        ? `${causeError.name}: ${causeError.message}`
        : cause === undefined
          ? undefined
          : String(cause),
  };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Header jazz reads a loopback progress URL from. Must match its own constant.
 *
 * No subscription header, deliberately: jazz sends everything when not asked to narrow, and
 * naming kinds would pin this to the list it sends today.
 */
const PROGRESS_HEADER = "x-jazz-progress-url";

export async function runTurn(
  daemon: DaemonSettings,
  threadKey: string,
  payload: string,
  /**
   * From `createIdleWatchdog`. The caller pokes and disposes it, since only the caller sees
   * the progress events. Taken whole rather than as a bare signal because a turn that dies
   * has to report how much progress it saw first.
   */
  watchdog: TurnWatchdog,
  /** Optional: a jazz without the route ignores it, and a turn without progress is valid. */
  progressUrl?: string,
): Promise<TurnResult> {
  // Should be unreachable: every payload is composed to this budget. A guard for a future
  // caller that builds one another way, whose alternative is jazz rejecting it and the room
  // being told nothing useful about why.
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    return { kind: "failed", reason: "the turn payload was too large for the daemon" };
  }

  const startedAt = Date.now();
  log.debug("waking the agent", {
    thread: threadKey,
    bytes: Buffer.byteLength(payload, "utf8"),
    reporting: progressUrl === undefined ? "off" : "on",
  });

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
      signal: watchdog.signal,
      // Bun's own five-minute cap is off because the watchdog above is the deadline that
      // knows whether the daemon is still working. Left on, it fired first on any turn whose
      // tool call ran longer than five minutes and threw the same `TimeoutError` the
      // watchdog throws, so the turn died at five minutes wearing a thirty-minute message.
      timeout: false,
    } as RequestInit & { timeout: boolean });
  } catch (error) {
    const stats = watchdog.stats();
    const elapsed = Date.now() - startedAt;
    const fields = {
      ...describeError(error),
      elapsed: seconds(elapsed),
      progress: stats.pokes,
      quiet: seconds(stats.quietMs),
      reporting: progressUrl === undefined ? "off" : "on",
      thread: threadKey,
    };

    // Nothing but this turn's watchdog aborts this signal, so `aborted` is the only fact that
    // tells our idle deadline apart from a timeout the fetch implementation imposed itself.
    // Both surface as `TimeoutError`, so the name cannot separate them — and the bridge has
    // reported "gone quiet for 30m" over a turn that died in five minutes.
    if (watchdog.signal.aborted) {
      log.error("no progress for the idle deadline — giving up on this turn", fields);
      return {
        kind: "failed",
        reason:
          `the daemon has gone quiet for ${String(Math.round(TURN_TIMEOUT_MS / 60_000))}m with no ` +
          "progress — the run may still be going; check `jazz runs`",
      };
    }

    if (isTimeout(error)) {
      log.error("the http client timed out on its own, before quartet's idle deadline", fields);
      return {
        kind: "failed",
        reason:
          `the request to the daemon timed out after ${seconds(elapsed)}, short of quartet's ` +
          `${String(Math.round(TURN_TIMEOUT_MS / 60_000))}m idle deadline — the run may still be ` +
          "going; check `jazz runs`",
      };
    }

    log.error("the request to the daemon failed", fields);
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
    log.error("jazz does not know this webhook", { webhook: daemon.webhook, status: 404 });
    return {
      kind: "failed",
      reason:
        `jazz has no webhook called "${daemon.webhook}" — check the "webhooks" list in ` +
        `~/.jazz/config.json`,
    };
  }

  // Deliberately not "run `jazz webhook token`": that mints a token, prints it once and
  // overwrites the keyring, so following it strands quartet's copy even harder than
  // whatever stranded it first. `quartet connect --new-token` mints *and* saves.
  if (response.status === 401) {
    log.error("jazz rejected the token", { webhook: daemon.webhook, status: 401 });
    return {
      kind: "failed",
      reason:
        `jazz rejected the token for "${daemon.webhook}" — mint a new one and save it with ` +
        `\`quartet connect --new-token\``,
    };
  }

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    // The status is logged as well as the sentence: the sentence is what the room is told,
    // the number is what a reader can look up.
    log.error("jazz refused the turn", {
      status: response.status,
      detail: detail?.error ?? "no body",
      elapsed: seconds(Date.now() - startedAt),
    });
    return {
      kind: "failed",
      reason: detail?.error ?? `jazz answered ${String(response.status)}`,
    };
  }

  const body = (await response.json().catch(() => null)) as
    | { answer?: string; costUSD?: number; costIncomplete?: boolean }
    | null;
  if (body === null) {
    log.error("jazz answered 200 with a body quartet could not parse", {
      elapsed: seconds(Date.now() - startedAt),
    });
  }
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
  const startedAt = Date.now();
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
  } catch (error) {
    log.error("could not answer the parked run", { run: runId, ...describeError(error) });
    return { kind: "failed", reason: "jazz daemon is not reachable — is `jazz daemon` running?" };
  }

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    log.error("jazz refused to resume the parked run", {
      run: runId,
      status: response.status,
      detail: detail?.error ?? "no body",
      elapsed: seconds(Date.now() - startedAt),
    });
    return {
      kind: "failed",
      reason: detail?.error ?? `jazz answered ${String(response.status)}`,
    };
  }

  const body = (await response.json().catch(() => null)) as
    | { answer?: string; costUSD?: number; costIncomplete?: boolean }
    | null;
  if (body === null) {
    log.error("jazz answered the parked run with a body quartet could not parse", {
      elapsed: seconds(Date.now() - startedAt),
    });
  }
  return interpretAnswer(body);
}

/** Exported for tests: what a daemon's answer means, with no HTTP in the way. */
export function interpretAnswer(
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

  // Both sentinels live at the *end* of a message and stay in it. A pass is therefore only
  // silence when it is the whole reply — a message that ends in one is a message, and
  // discarding it would throw away the very thing an agent was told to post: the
  // instructions ask an agent facing something hard to state the problem and then pass, so
  // that the room can answer it.
  //
  // This used to treat anything *starting* with a pass as silence, which meant a model that
  // led with the sentinel had the rest of its turn deleted with nothing to show it. Nothing
  // reads them positionally now, so the worst a misplaced sentinel can do is look untidy.
  if (answer === PASS_SENTINEL) return { kind: "passed", cost };

  // Kept in the text rather than stripped, so a reader sees an agent yield or say goodbye
  // the same way the agent wrote it. Only the closing *effect* is read out of it here.
  return { kind: "said", text: answer, cost, closing: answer.includes(CLOSE_SENTINEL) };
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
 * Read as a fallback, not as the record. The webhook entry *is* what decides which agent
 * fires, so this was once quartet's only copy — "two copies would be one copy and a lie".
 * That held only while a webhook name belonged to one identity. It didn't: every identity
 * on a host defaulted to the name `quartet`, so the entry was whatever the last `connect`
 * wrote, and an identity asking it which agent represents me got somebody else's answer.
 * `QuartetConfig.agentId` is the record now; this covers configs written before it existed.
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

/**
 * One webhook per quartet identity, not one per machine.
 *
 * A fixed `"quartet"` was a collision waiting to happen, and it happened: several identities
 * on one host each wrote the same webhook entry, so every `connect` repointed the previous
 * identity's agent and — because minting a token overwrites the keyring entry, which is keyed
 * by name — invalidated the token it had saved. Those identities then failed every turn with
 * a 401 they could do nothing about, while the two that had been given explicit `--webhook`
 * names worked throughout. Handles are unique hub-side, which makes them the one name
 * available here that cannot collide.
 */
export function defaultWebhookName(handle: string | undefined): string {
  const slug = (handle ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // No handle yet means no unique name to build from. Falling back to the bare `"quartet"`
  // is the old colliding name, so it is deliberately only reachable before a handle is
  // claimed — which `connect` does before it ever asks about the daemon.
  return slug.length > 0 ? `quartet-${slug}` : "quartet";
}

/** The environment variable jazz reads a webhook's token from when there is no keyring. */
export function webhookTokenEnvVar(webhookName: string): string {
  return `JAZZ_WEBHOOK_TOKEN_${webhookName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
