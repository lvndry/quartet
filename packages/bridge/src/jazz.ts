/**
 * @fileoverview Talking to the jazz daemon on this machine, and setting it up to be talked to.
 *
 * Quartet drives the webhook door jazz already ships — `POST /triggers/<name>` — so nothing
 * in jazz had to change for this to work. The one thing quartet needs from that door is
 * memory across turns, which arrived as `conversation: "threaded"`: every fire carrying the
 * same `X-Jazz-Thread` resumes one conversation, so the agent remembers the exchange instead
 * of meeting it fresh each time.
 *
 * One conversation in quartet is one thread key. Separate conversations with the same person
 * therefore get separate agent memories, which is what stops last week's invoice thread
 * leaking into today's dinner plans.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { PASS_SENTINEL } from "@quartet/protocol";
import type { DaemonSettings } from "./config";
import { triggerPromptTemplate } from "./prompt";

export type TurnResult =
  | { readonly kind: "said"; readonly text: string }
  | { readonly kind: "passed" }
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
    response = await fetch(`${daemon.url}/triggers/${encodeURIComponent(daemon.trigger)}`, {
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

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    return { kind: "failed", reason: detail?.error ?? `jazz answered ${String(response.status)}` };
  }

  const body = (await response.json().catch(() => null)) as { answer?: string } | null;
  const answer = body?.answer?.trim() ?? "";
  if (answer.length === 0) return { kind: "failed", reason: "jazz returned an empty answer" };
  if (answer === PASS_SENTINEL || answer.startsWith(PASS_SENTINEL)) return { kind: "passed" };
  return { kind: "said", text: answer };
}

export async function daemonReachable(daemon: DaemonSettings): Promise<boolean> {
  try {
    const response = await fetch(`${daemon.url}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

interface JazzTriggerEntry {
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
 * Add quartet's trigger to the operator's jazz config, leaving everything else alone.
 *
 * Rewriting somebody's config is not a thing to do casually, so this is surgical: it merges
 * one entry into `triggers` by name and touches nothing it did not put there. The token is
 * deliberately *not* written — it belongs in the keyring or the environment, and jazz looks
 * in both.
 */
export async function ensureJazzTrigger(input: {
  triggerName: string;
  agentId: string;
}): Promise<{ changed: boolean; path: string }> {
  const path = jazzConfigPath();
  const file = Bun.file(path);
  const config = ((await file.exists()) ? await file.json().catch(() => ({})) : {}) as {
    triggers?: JazzTriggerEntry[];
  };

  const entry: JazzTriggerEntry = {
    name: input.triggerName,
    agentId: input.agentId,
    conversation: "threaded",
    promptTemplate: triggerPromptTemplate(),
    description: "quartet — one turn in a conversation with another person's agent",
  };

  const existing = config.triggers ?? [];
  const index = existing.findIndex((trigger) => trigger.name === input.triggerName);
  const already =
    index !== -1 &&
    existing[index]?.agentId === entry.agentId &&
    existing[index]?.conversation === entry.conversation &&
    existing[index]?.promptTemplate === entry.promptTemplate;
  if (already) return { changed: false, path };

  const triggers = index === -1 ? [...existing, entry] : existing.map((t, i) => (i === index ? entry : t));
  await Bun.write(path, `${JSON.stringify({ ...config, triggers }, null, 2)}\n`);
  return { changed: true, path };
}

/** The environment variable jazz reads a trigger's token from when there is no keyring. */
export function triggerTokenEnvVar(triggerName: string): string {
  return `JAZZ_TRIGGER_TOKEN_${triggerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
