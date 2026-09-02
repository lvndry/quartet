/**
 * @fileoverview Everything your agent has said to somebody else, kept on this machine.
 *
 * Written when the hub confirms a message, and again on welcome for any confirmed line
 * this process never got to append — a crash between `appended` and disk used to drop
 * that line. Catch-up copies only messages already attributed to you. The hub still has
 * no route that accepts this file.
 *
 * Append-only JSONL. A process killed mid-write should cost the last line, not the file.
 * A write that fails is reported; the room is not silently treated as complete.
 */

import { dirname } from "node:path";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import type { Message } from "@quartet/protocol";
import { asidesPath, ledgerPath } from "./paths";

export { ledgerPath };

export interface LedgerEntry {
  /** The hub's id for the message. Dedupes replays and reconnects. */
  readonly id: string;
  readonly at: string;
  readonly conversationId: string;
  readonly to: string;
  readonly text: string;
  readonly steer?: string;
}

export interface AsideRecord {
  readonly at: string;
  readonly conversationId: string;
  readonly text: string;
}

export async function recordSent(entry: LedgerEntry): Promise<string | undefined> {
  const path = ledgerPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "could not write the local record";
  }
}

export async function readLedger(conversationId?: string): Promise<LedgerEntry[]> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath(), "utf-8");
  } catch {
    return [];
  }
  const entries: LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as LedgerEntry;
      if (typeof parsed.id !== "string" || typeof parsed.text !== "string") continue;
      if (conversationId === undefined || parsed.conversationId === conversationId) {
        entries.push(parsed);
      }
    } catch {
      // A partial final line from an interrupted write. Skipping it is the recovery.
    }
  }
  return entries;
}

/** Confirmed agent lines of yours that the local file does not yet have. */
export function missingOutgoing(
  messages: readonly Message[],
  meHandle: string,
  knownIds: ReadonlySet<string>,
): Message[] {
  return messages.filter(
    (message) =>
      message.kind === "agent" &&
      message.authorHandle === meHandle &&
      !knownIds.has(message.id),
  );
}

export async function recordAside(aside: AsideRecord): Promise<string | undefined> {
  const path = asidesPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(aside)}\n`, "utf-8");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "could not write your aside";
  }
}

export async function readAsides(): Promise<AsideRecord[]> {
  let raw: string;
  try {
    raw = await readFile(asidesPath(), "utf-8");
  } catch {
    return [];
  }
  const entries: AsideRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as AsideRecord;
      if (typeof parsed.text === "string" && typeof parsed.conversationId === "string") {
        entries.push(parsed);
      }
    } catch {
      // Same discipline as the ledger: a torn last line is skipped.
    }
  }
  return entries;
}
