/**
 * @fileoverview What each key calls itself, on this machine.
 *
 * Pinned the other way round from how this started. While a handle was unique per hub, the
 * question worth asking was "has @mira's key changed", because only an attack or a reinstall
 * could change it. Now that a handle is a label and two friends may share one, that question
 * has an innocent answer — a second @mira is a second person — and asking it would cry wolf
 * every time somebody's friend picked a popular name.
 *
 * The question that stayed sharp is the mirror of it: *has a key I know started wearing a
 * different name*. Nothing innocent needs that. A key is an identity somebody proved they
 * hold, so a key that was @mira last week and is @robin today has either been renamed by its
 * owner or is being walked into a room where @robin means somebody else.
 *
 * Trust on first use, with its weakness — the first answer is taken on faith. The fingerprint
 * in an invite is what fixes that, when somebody reads it to you out of band.
 */

import { readFile } from "node:fs/promises";
import { isDid } from "@quartet/identity";
import { writeJsonAtomically } from "./atomic";
import { knownPath } from "./paths";

// Surfaced to the app, so it is defined with the rest of the snapshot contract.
import type { Conflict } from "@quartet/protocol";
export type { Conflict };

export class KnownKeys {
  /** did → the handle that key was first seen wearing. */
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
      for (const [did, handle] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof handle === "string" && isDid(did)) this.pinned.set(did, handle);
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

  /** What this key has been calling itself, if this machine has seen it before. */
  handleOf(did: string): string | undefined {
    return this.pinned.get(did);
  }

  conflict(did: string): Conflict | undefined {
    return this.conflicts.get(did);
  }

  all(): Conflict[] {
    return [...this.conflicts.values()];
  }

  /**
   * Record what the hub says this key calls itself.
   *
   * Returns the conflict when the name has changed under us, and never overwrites: the pinned
   * name is what somebody may have checked by hand, and a hub does not get to replace it by
   * asserting louder. Clearing a conflict is a deliberate act — see `repin`.
   */
  offer(did: string, handle: string): Conflict | undefined {
    // Pinning on top of a file we failed to read would quietly replace whatever it held.
    if (this.unreadable) return undefined;

    const known = this.pinned.get(did);
    if (known === undefined) {
      this.pinned.set(did, handle);
      void this.save();
      return undefined;
    }
    if (known === handle) {
      this.conflicts.delete(did);
      return undefined;
    }

    const conflict: Conflict = { did, known, offered: handle };
    this.conflicts.set(did, conflict);
    return conflict;
  }

  /** Accept a key's new name, after a person has decided that is what they want. */
  async repin(did: string, handle: string): Promise<void> {
    // A person has looked at this one, which is a better answer than a file we could not
    // read — so this is also how somebody recovers from a damaged one.
    this.unreadable = false;
    this.pinned.set(did, handle);
    this.conflicts.delete(did);
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
