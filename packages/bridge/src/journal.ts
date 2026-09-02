/**
 * @fileoverview How far each conversation has got, kept across restarts.
 *
 * The chain that makes a deleted line visible is only as good as the memory of where it had
 * reached. Held in RAM alone it fails twice over, and both failures are worse than not having
 * it: a bridge that restarts signs its next line as if it were the first, so the *other* side
 * reports a gap that never happened — and a bridge that restarts having forgotten what it had
 * seen will accept a hub quietly dropping everything up to that point.
 *
 * A false alarm here is the more expensive of the two. The whole value of the warning is that
 * it is rare enough to be worth reading, and an alarm that fires every time somebody reboots
 * is one people learn to click past — at which point the real one goes past too.
 *
 * None of this is secret. Every link is a digest of a signature the hub already holds.
 */

import { readFile } from "node:fs/promises";
import { writeJsonAtomically } from "./atomic";
import { journalPath } from "./paths";

interface Persisted {
  /** Conversation id to the digest of the last line this agent signed in it. */
  own: Record<string, string>;
  /** "conversation handle" to the digest of the last line seen from that author. */
  seen: Record<string, string>;
}

function readRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

export class Journal {
  private own = new Map<string, string>();
  private seen = new Map<string, string>();
  private readonly path: string;

  /** Passed in for the same reason the pin file is: one process can run two agents. */
  constructor(path: string = journalPath()) {
    this.path = path;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      this.own = new Map(Object.entries(readRecord(parsed.own)));
      this.seen = new Map(Object.entries(readRecord(parsed.seen)));
    } catch {
      // Starting blank costs one spurious "signed as if first" on each side and no false
      // alarms after that. Refusing to start would be a worse trade for a derived file.
    }
  }

  lastOwn(conversationId: string): string {
    return this.own.get(conversationId) ?? "";
  }

  recordOwn(conversationId: string, link: string): void {
    this.own.set(conversationId, link);
    void this.save();
  }

  lastSeen(key: string): string | undefined {
    return this.seen.get(key);
  }

  recordSeen(key: string, link: string): void {
    this.seen.set(key, link);
    void this.save();
  }

  private async save(): Promise<void> {
    const snapshot: Persisted = {
      own: Object.fromEntries(this.own),
      seen: Object.fromEntries(this.seen),
    };
    try {
      await writeJsonAtomically(this.path, snapshot);
    } catch {
      // Losing this costs the spurious-first-line case above on the next run. Failing the
      // turn that triggered it would be a far larger harm than the thing being protected.
    }
  }
}
