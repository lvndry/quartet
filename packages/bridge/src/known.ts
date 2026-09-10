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
 * A second @mira is still not that question, and still not refused. But it is not nothing
 * either, so this file keeps the index that answers "who else here already answers to this
 * name" — and hands it to `invite`, which refuses a bare handle more than one key wears,
 * rather than to a banner. A name is worth interrupting somebody over at the moment they act
 * on it and nowhere else; a standing notice about two friends who picked one name is how the
 * alarm next to it stops being read.
 *
 * Pins are recorded per hub, because a handle *is* a row in one hub's database. Pooling them
 * gave every hub a first-writer's veto over what this machine believed about keys on all the
 * others: assert a did you found in public wearing some other name, and the legitimate hub's
 * own listing raises a rename alarm about a correspondent who did nothing.
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
  /** did → the handle that key was first seen wearing *on this hub*. */
  private readonly pinned = new Map<string, string>();
  /**
   * handle → every key pinned to it on this hub. The same facts as `pinned`, read the other
   * way round.
   *
   * Derived rather than stored, and rebuilt from `pinned` on load, so there is one thing on
   * disk and no way for the two directions to disagree about it. `pinned` alone could only
   * answer "what does this key call itself", which left the mirror question — "who else here
   * already answers to this name" — costing a scan nobody was doing. `invite` asks it, and
   * the answer is what stops a hub choosing the candidate set for a name.
   */
  private readonly wearers = new Map<string, string[]>();
  private readonly conflicts = new Map<string, Conflict>();
  /**
   * The other hubs' pins, held opaquely so saving this hub's cannot erase them.
   *
   * Never read to decide anything. A handle is a row in one hub's database, so what another
   * hub calls a key is not evidence about this one — and treating it as evidence is what let
   * any hub raise a rename alarm about a key it had never been asked about. Kept only so one
   * file can hold every hub without each save clobbering the last.
   */
  private otherHubs: Record<string, Record<string, string>> = {};
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
  /** Set when the file was readable but written before pins recorded which hub said them. */
  private legacy = false;

  /**
   * The file is passed in rather than resolved here.
   *
   * Two agents on one host are two data directories, and the module-level data directory is
   * one value per process — so a bridge that looked the path up itself would quietly share a
   * pin file with its neighbour, and each save would erase the other's.
   */
  constructor(
    /**
     * The hub whose pins this instance reads and writes.
     *
     * Required rather than defaulted, because there is no sensible fallback: a `KnownKeys`
     * that guessed would pool two hubs' names into one namespace, which is exactly the
     * conflation this argument exists to end.
     */
    private readonly hub: string,
    path: string = knownPath(),
  ) {
    this.path = path;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.unreadable = true;
      return;
    }
    // A file that parses but is not a map of hubs is not a first run either. Failing open
    // here would treat "pins existed and I cannot use them" as "there were never any",
    // which is the one moment a hostile hub gets a free key swap.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.unreadable = true;
      return;
    }
    for (const [hub, pins] of Object.entries(parsed as Record<string, unknown>)) {
      // An older build wrote did → handle at the top level, with no hub above it. Those pins
      // cannot be attributed to a hub after the fact, and guessing this one would import
      // another hub's names into it — so this fails closed rather than silently repinning.
      if (typeof pins === "string") {
        this.unreadable = true;
        this.legacy = true;
        return;
      }
      if (typeof pins !== "object" || pins === null) continue;
      const entries = Object.entries(pins as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && isDid(entry[0]),
      );
      if (hub === this.hub) {
        for (const [did, handle] of entries) this.pin(did, handle);
      } else if (entries.length > 0) {
        this.otherHubs[hub] = Object.fromEntries(entries);
      }
    }
  }

  /** Why this bridge cannot vouch for any pin right now, if it cannot. */
  problem(): string | undefined {
    if (!this.unreadable) return undefined;
    if (this.legacy) {
      return (
        `${this.path} was written by an older build, which recorded a name per key without ` +
        "the hub that said it — so those pins cannot be trusted to this hub. Compare " +
        "fingerprints before trusting anything, then move that file aside to start pinning again."
      );
    }
    return (
      `${this.path} could not be read, so no key here is pinned. Compare fingerprints before ` +
      "trusting anything, then move that file aside to start pinning again."
    );
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
   * Every key this machine has pinned to a name on this hub.
   *
   * The point of the reverse index, and the reason it is worth keeping a second direction on
   * disk. `invite` refuses a bare handle when more than one key wears it, but it was reading
   * that set off the hub's own directory — so a hub could drop the @mira you know at the
   * moment it lists a stranger wearing the name, leave exactly one candidate, and buy
   * silence from the check meant to speak. A pin is the one record of that name the hub does
   * not get to edit, and a pinned key is by construction one you have already met.
   */
  wearersOf(handle: string): string[] {
    return [...(this.wearers.get(handle) ?? [])].sort();
  }

  /**
   * Every name on this hub that more than one pinned key wears, with those keys.
   *
   * Feeds the label set rather than a notice. `displayTag` writes as much fingerprint as it
   * takes to separate the keys it can *see*, so a key it cannot see is a key it will not
   * lengthen a prefix against — and the second @mira would render as a bare, unqualified
   * `@mira` precisely when the first one is missing from the screen. Which is the case a hub
   * arranges deliberately.
   */
  contestedNames(): { handle: string; dids: string[] }[] {
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
   * A key this machine has never seen on this hub is pinned, whatever name it arrives
   * wearing and whoever else here already answers to it. That is the design and not an
   * oversight: a handle is a label, two people who never met are both entitled to @mira, and
   * refusing the second would be the hub rationing names it has no standing to ration. What
   * the second key does buy is a `wearersOf` entry, which is what `invite` refuses on — the
   * signal belongs at the moment somebody acts on a name, not on a banner beside it.
   *
   * Only a key this hub has already named, wearing a different name here, is a conflict.
   */
  offer(did: string, handle: string): Conflict | undefined {
    // Pinning on top of a file we failed to read would quietly replace whatever it held.
    if (this.unreadable) return undefined;

    const known = this.pinned.get(did);
    if (known === undefined) {
      this.pin(did, handle);
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
    this.legacy = false;
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
      await writeJsonAtomically(this.path, {
        ...this.otherHubs,
        [this.hub]: Object.fromEntries([...this.pinned.entries()].sort()),
      });
    } catch {
      // Failing the send that triggered this would be the worse harm, so it is swallowed —
      // but not harmlessly, and the old comment here claimed otherwise. A lost pin is
      // re-offered next run and pins silently, so a read-only or full data directory
      // degrades this to permanent no-pinning with nothing on screen saying so. Surfacing a
      // failed save through `problem()` is the fix, and is not in this change.
    }
  }
}
