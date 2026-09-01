/**
 * @fileoverview Talking to the jazz daemon on this machine, and setting it up to be talked to.
 *
 * Quartet drives `POST /webhooks/<name>` with `conversation: "threaded"`, so the agent
 * remembers the exchange across turns. One conversation is one thread key, keeping last
 * week's invoice thread out of today's dinner plans.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { PASS_SENTINEL } from "@quartet/protocol";
import type { DaemonSettings } from "./config";
import { webhookPromptTemplate } from "./prompt";

/** What a turn cost, when the daemon could tell. `incomplete` means the figure is a floor. */
export interface TurnCost {
  readonly costUSD?: number;
  readonly incomplete: boolean;
}

export type TurnResult =
  | { readonly kind: "said"; readonly text: string; readonly cost: TurnCost }
  | { readonly kind: "passed"; readonly cost: TurnCost }
  | { readonly kind: "needs-you"; readonly runId: string }
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
    const parked = (await response.json().catch(() => null)) as { runId?: string } | null;
    return { kind: "needs-you", runId: parked?.runId ?? "unknown" };
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
  const answer = body?.answer?.trim() ?? "";
  // An unpriced run is marked rather than assumed free: a local model reports no cost, and
  // treating that as zero would let a spend ceiling sit at zero forever.
  const cost: TurnCost = {
    ...(typeof body?.costUSD === "number" ? { costUSD: body.costUSD } : {}),
    incomplete: body?.costIncomplete === true || typeof body?.costUSD !== "number",
  };
  if (answer.length === 0) return { kind: "failed", reason: "jazz returned an empty answer" };
  if (answer === PASS_SENTINEL || answer.startsWith(PASS_SENTINEL)) return { kind: "passed", cost };
  return { kind: "said", text: answer, cost };
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
