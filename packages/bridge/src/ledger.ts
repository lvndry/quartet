/**
 * @fileoverview Everything your agent has said to somebody else, kept on your machine.
 *
 * Written when the hub confirms a message, not when the bridge sends one. That distinction
 * is load-bearing: the hub also appends messages on your behalf — the invite's opening line
 * is one — and a ledger built from what the bridge remembers sending would silently miss
 * them. Recording on confirmation means the list is everything actually attributed to you,
 * whoever put it there.
 *
 * So the claim is narrow and true: if it is not here, it did not cross. That is much less
 * than "here is what my agent chose not to reveal" — nothing in the system can know which
 * facts an agent decided to omit — but it is the whole reason the panel sits beside the
 * conversation rather than in a settings page.
 *
 * The gap it accepts: a message confirmed by the hub while this process is dying is lost to
 * the local file. Reconciling against hub history on reconnect would close it and is not
 * done yet.
 *
 * Append-only JSONL, unparseable lines skipped, same discipline as jazz's own logs: a
 * process killed mid-write should cost the last line, not the file. It never leaves this
 * machine — the hub has no route that accepts it.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendFile, mkdir, readFile } from "node:fs/promises";

export interface LedgerEntry {
  /** The hub's id for the message. Dedupes replays and reconnects. */
  readonly id: string;
  readonly at: string;
  readonly conversationId: string;
  /** Who it went to. Recorded per entry so the file stays readable on its own. */
  readonly to: string;
  readonly text: string;
  /** Present when the owner asked for this turn, so you can see what prompted what. */
  readonly steer?: string;
}

export function ledgerPath(): string {
  return join(process.env["QUARTET_HOME"] ?? join(homedir(), ".quartet"), "sent.jsonl");
}

export async function recordSent(entry: LedgerEntry): Promise<void> {
  const path = ledgerPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // Losing a line must not fail the message that produced it. The tradeoff is real and
    // uncomfortable: a full disk produces silent gaps in the one record whose value is being
    // complete, and nothing here detects that yet.
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
      if (conversationId === undefined || parsed.conversationId === conversationId) {
        entries.push(parsed);
      }
    } catch {
      // A partial final line from an interrupted write. Skipping it is the recovery.
    }
  }
  return entries;
}
