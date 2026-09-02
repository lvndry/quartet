/**
 * @fileoverview Which key each handle is known by, on this machine.
 *
 * The hub is the only thing that tells a bridge what key sits behind `@mira`, and the hub is
 * exactly what this whole layer declines to trust. Pinning is what closes that: the first
 * answer is written down, and every answer after it has to agree. A hub that swaps the key
 * behind a familiar name cannot do it quietly — it can only do it loudly, once.
 *
 * This is trust on first use, and it inherits the weakness of the idea: the *first* answer is
 * taken on faith. That is what the fingerprint in an invite is for. Somebody who read
 * `@mira#4f2a-…` to you over the phone has already told you the answer, and the first use is
 * checked rather than assumed.
 */

import { readFile } from "node:fs/promises";
import { isDid } from "@quartet/identity";
import { writeJsonAtomically } from "./atomic";
import { knownPath } from "./paths";

/** A handle whose key changed under us, and what it changed between. */
export interface Conflict {
  readonly handle: string;
  readonly pinned: string;
  readonly offered: string;
}

export class KnownKeys {
  private readonly pinned = new Map<string, string>();
  private readonly conflicts = new Map<string, Conflict>();
  private readonly path: string;
  /**
   * Set when the file exists but could not be read back.
   *
   * Distinct from having no file at all, and the difference decides everything: a first run
   * legitimately pins whatever the hub offers, while a damaged file means pins existed and
   * are now unreadable. Treating the second as the first would hand a hostile hub a clean
   * key swap at exactly the moment nothing is left to contradict it.
   */
  private unreadable = false;

  /**
   * The file is passed in rather than resolved here.
   *
   * Two agents on one host are two data directories, and the module-level data directory is
   * one value per process — so a bridge that looked the path up itself would quietly share a
   * pin file with its neighbour, and each save would erase the other's.
   */
  constructor(path: string = knownPath()) {
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
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return;
      for (const [handle, did] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof did === "string" && isDid(did)) this.pinned.set(handle, did);
      }
    } catch {
      this.unreadable = true;
    }
  }

  /** Why this bridge cannot vouch for any pin right now, if it cannot. */
  problem(): string | undefined {
    return this.unreadable
      ? `${this.path} could not be read, so no key here is pinned. Compare fingerprints before ` +
          "trusting anything, then move that file aside to start pinning again."
      : undefined;
  }

  did(handle: string): string | undefined {
    return this.pinned.get(handle);
  }

  conflict(handle: string): Conflict | undefined {
    return this.conflicts.get(handle);
  }

  all(): Conflict[] {
    return [...this.conflicts.values()];
  }

  /**
   * Record what the hub says a handle's key is.
   *
   * Returns the conflict when this contradicts what was pinned, and never overwrites: the
   * pinned key is the one somebody may have checked by hand, and a hub does not get to
   * replace it by asserting louder. Clearing a conflict is a deliberate act — see `repin`.
   */
  offer(handle: string, did: string): Conflict | undefined {
    // Pinning on top of a file we failed to read would quietly replace whatever it held.
    if (this.unreadable) return undefined;

    const pinned = this.pinned.get(handle);
    if (pinned === undefined) {
      this.pinned.set(handle, did);
      void this.save();
      return undefined;
    }
    if (pinned === did) {
      this.conflicts.delete(handle);
      return undefined;
    }

    const conflict: Conflict = { handle, pinned, offered: did };
    this.conflicts.set(handle, conflict);
    return conflict;
  }

  /** Accept a new key for a handle, after a person has decided that is what they want. */
  async repin(handle: string, did: string): Promise<void> {
    // A person has looked at this one, which is a better answer than a file we could not
    // read — so this is also how somebody recovers from a damaged one.
    this.unreadable = false;
    this.pinned.set(handle, did);
    this.conflicts.delete(handle);
    await this.save();
  }

  private async save(): Promise<void> {
    try {
      await writeJsonAtomically(this.path, Object.fromEntries([...this.pinned.entries()].sort()));
    } catch {
      // Losing a pin costs a re-pin on the next run, which is a warning somebody sees rather
      // than a silent downgrade. Failing the send that triggered it would be the worse harm.
    }
  }
}
