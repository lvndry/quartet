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

/** Cap chosen to sit under jazz's own 20 KB body limit with room for the JSON envelope. */
const MAX_PAYLOAD_BYTES = 18_000;

export async function runTurn(
  daemon: DaemonSettings,
  threadKey: string,
  payload: string,
): Promise<TurnResult> {
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    return { kind: "failed", reason: "transcript too long for one turn" };
  }

  let response: Response;
  try {
    response = await fetch(`${daemon.url}/webhooks/${encodeURIComponent(daemon.webhook)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
        "x-jazz-thread": threadKey,
      },
      body: payload,
    });
  } catch {
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
    promptTemplate: webhookPromptTemplate(),
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
