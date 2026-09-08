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
 * A second @mira is still not that question, and still not refused — but it is not nothing
 * either. It reads as two people from here and as one to a reader skimming a list, and the
 * only party who can tell those apart is the person who knows which fingerprint they meant.
 * So this file keeps the index that answers it, and says so; what it does not do is pick.
 *
 * Trust on first use, with its weakness — the first answer is taken on faith. The fingerprint
 * in an invite is what fixes that, when somebody reads it to you out of band.
 */

import { readFile } from "node:fs/promises";
import { isDid } from "@quartet/identity";
import { writeJsonAtomically } from "./atomic";
import { knownPath } from "./paths";

// Surfaced to the app, so they are defined with the rest of the snapshot contract.
import type { Conflict, SharedHandle } from "@quartet/protocol";
export type { Conflict, SharedHandle };

/**
 * What offering a name turned up, when it turned up anything.
 *
 * Tagged rather than told apart by shape, because the two arms mean opposite things and the
 * caller has to act differently on each: one is an alarm about a key, the other is a note
 * about a name. A union a reader had to probe with `"handle" in notice` would be one rename
 * away from silently taking the wrong branch.
 *
 * Bridge-internal, unlike the two payloads it carries: it is the answer to a single call,
 * not part of what the app is shown.
 */
export type NameNotice =
  | { readonly kind: "renamed"; readonly conflict: Conflict }
  | { readonly kind: "shared"; readonly shared: SharedHandle };

export class KnownKeys {
  /** did → the handle that key was first seen wearing. */
  private readonly pinned = new Map<string, string>();
  /**
   * handle → every key pinned to it. The same facts as `pinned`, read the other way round.
   *
   * Derived rather than stored, and rebuilt from `pinned` on load, so there is one thing on
   * disk and no way for the two directions to disagree about it. `pinned` alone could only
   * answer "what does this key call itself", which left the mirror question — "who else
   * already answers to this name" — costing a scan nobody was doing.
   */
  private readonly wearers = new Map<string, string[]>();
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
        if (typeof handle === "string" && isDid(did)) this.pin(did, handle);
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
   * Every name this machine has pinned more than one key to.
   *
   * Derived on each read rather than latched when it happens, because it is a standing fact
   * about this address book and not an event: while two keys here wear @mira, a person
   * writing to @mira is choosing between them whether or not anybody told them so. Latching
   * it would mean a restart quietly dropped the note while both keys were still on file.
   *
   * Which also means there is nothing to clear, and no button that clears it. The remedy is
   * knowing which fingerprint is which, and that is not something a bridge can be told.
   */
  sharedHandles(): SharedHandle[] {
    return [...this.wearers.entries()]
      .filter(([, dids]) => dids.length > 1)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([handle, dids]) => ({ handle, dids: [...dids].sort() }));
  }

  /**
   * Record what the hub says this key calls itself.
   *
   * Never overwrites: the pinned name is what somebody may have checked by hand, and a hub
   * does not get to replace it by asserting louder. Clearing a conflict is a deliberate
   * act — see `repin`.
   *
   * Two things can come back, and which one does turns on whether the *key* was new or the
   * *name* was. A key this machine knows, wearing a name it did not, is `renamed` and the
   * pin does not move. A key this machine has never seen is pinned either way — that is the
   * design, and refusing it would be rationing names — but when the name it arrives wearing
   * already belongs to somebody else here, the pin comes with a `shared` note attached.
   *
   * They cannot both happen at once: only a pin that lands can put a second key on a name,
   * and a rename does not land.
   */
  offer(did: string, handle: string): NameNotice | undefined {
    // Pinning on top of a file we failed to read would quietly replace whatever it held.
    if (this.unreadable) return undefined;

    const known = this.pinned.get(did);
    if (known === undefined) {
      const strangers = this.wearers.get(handle) ?? [];
      this.pin(did, handle);
      void this.save();
      if (strangers.length === 0) return undefined;
      // The note names every key on the name, this one included. A person told "somebody
      // else is already @mira" without being told who is worse off than one told nothing:
      // they have an alarm and nothing to check it against.
      return { kind: "shared", shared: { handle, dids: [...strangers, did].sort() } };
    }
    if (known === handle) {
      this.conflicts.delete(did);
      return undefined;
    }

    const conflict: Conflict = { did, known, offered: handle };
    this.conflicts.set(did, conflict);
    return { kind: "renamed", conflict };
  }

  /** Accept a key's new name, after a person has decided that is what they want. */
  async repin(did: string, handle: string): Promise<void> {
    // A person has looked at this one, which is a better answer than a file we could not
    // read — so this is also how somebody recovers from a damaged one.
    this.unreadable = false;
    this.pin(did, handle);
    this.conflicts.delete(did);
    await this.save();
  }

  /**
   * Write one key's name down in both directions at once.
   *
   * The only place `pinned` is assigned, so the index cannot be left behind by a path that
   * forgot it. It also un-wears the previous name, which is what makes `repin` not leave a
   * key counted under a handle it has stopped answering to — a phantom second @mira, which
   * is precisely the note this index exists to raise honestly.
   */
  private pin(did: string, handle: string): void {
    const was = this.pinned.get(did);
    if (was === handle) return;
    if (was !== undefined) {
      const left = (this.wearers.get(was) ?? []).filter((other) => other !== did);
      if (left.length === 0) this.wearers.delete(was);
      else this.wearers.set(was, left);
    }
    this.pinned.set(did, handle);
    this.wearers.set(handle, [...(this.wearers.get(handle) ?? []), did]);
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
