/**
 * @fileoverview What the app is handed when two keys on this machine wear one name.
 *
 * `known.test.ts` covers the decision — that a second @mira is pinned, is not a `Conflict`,
 * and is said out loud. This covers the part that decides whether saying it was any use: a
 * note naming two keys is only actionable if the snapshot beside it can write both of them
 * down distinguishably, and both halves of that are computed somewhere else.
 *
 * The bridge is built but never started, and its directory stays empty on purpose. Every
 * name and fingerprint asserted here therefore has to have come from the pin file, which is
 * the case that used to produce a bare, unqualified `@mira`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayTag, fingerprint, generateKeypair, generateSealingKeypair } from "@quartet/identity";
import { Attestor } from "./attest";
import { Bridge } from "./bridge";
import { KnownKeys } from "./known";
import { Sealer } from "./sealer";
import { setIdentityDirectory } from "./paths";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "quartet-shared-"));
  setIdentityDirectory(workDir);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A bridge with nothing but a pin file: no hub, no directory, no connections. */
async function bridgeKnowing(pins: readonly [string, string][]): Promise<Bridge> {
  const known = new KnownKeys(join(workDir, `known-${String(pins.length)}-${Bun.nanoseconds()}.json`));
  await known.load();
  for (const [did, handle] of pins) known.offer(did, handle);
  return new Bridge(
    "http://127.0.0.1:1",
    { url: "http://127.0.0.1:1", webhook: "quartet", token: "t" },
    new Attestor(generateKeypair()),
    new Sealer({ current: generateSealingKeypair(), retired: [] }),
    known,
  );
}

describe("what the app is told about two keys wearing one name", () => {
  it("carries the note, and a fingerprint for every key in it", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const bridge = await bridgeKnowing([
      [mira.did, "mira"],
      [alsoMira.did, "mira"],
    ]);

    const state = bridge.snapshot();
    expect(state.sharedHandles).toEqual([
      { handle: "mira", dids: [mira.did, alsoMira.did].sort() },
    ]);
    // Not a conflict, and the two lists must not leak into each other.
    expect(state.keyConflicts).toEqual([]);

    // The part the note cannot do without. Neither key is in the directory — the other @mira
    // going offline, or being dropped from a hostile hub, is the ordinary way this happens —
    // so a snapshot that only fingerprinted the directory would name two keys in the note
    // and be unable to write either of them down.
    expect(state.fingerprints[mira.did]).toBe(fingerprint(mira.did));
    expect(state.fingerprints[alsoMira.did]).toBe(fingerprint(alsoMira.did));
  });

  it("writes them with the fingerprint attached, not as a bare handle each", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const bridge = await bridgeKnowing([
      [mira.did, "mira"],
      [alsoMira.did, "mira"],
    ]);

    const { labels } = bridge.snapshot();
    // The whole point of one label map computed over everyone known: `@mira` on its own is
    // now a name that does not say who, so neither of them gets to be written that way.
    expect(labels[mira.did]).not.toBe("@mira");
    expect(labels[alsoMira.did]).not.toBe("@mira");
    expect(labels[mira.did]).not.toBe(labels[alsoMira.did]);
    expect(labels[mira.did]).toStartWith("@mira#");
  });

  it("reaches into the pin file for the shared names only, not for all of it", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const robin = generateKeypair();
    const bridge = await bridgeKnowing([
      [mira.did, "mira"],
      [alsoMira.did, "mira"],
      [robin.did, "robin"],
    ]);

    const state = bridge.snapshot();
    expect(state.sharedHandles.map((shared) => shared.handle)).toEqual(["mira"]);

    // @robin is pinned here and appears in neither map, which is the intended narrowness.
    // The pin file accumulates everybody this machine has ever been told about, and pouring
    // all of it into the names on screen would put strangers in the set that decides how
    // long a fingerprint has to be — lengthening everybody's against keys nobody can see.
    expect(state.labels[robin.did]).toBeUndefined();
    expect(state.fingerprints[robin.did]).toBeUndefined();
    expect(state.labels[mira.did]).toStartWith("@mira#");
  });
});

describe("how much fingerprint a shared name is written with", () => {
  /**
   * The claim this rests on, stated because it is the one an attacker attacks: four hex
   * digits is sixteen bits, and grinding a key whose fingerprint opens with a chosen group
   * costs about 65k keygens — a few seconds. That is only survivable because the short form
   * is not a fixed four digits; it grows until it separates the keys actually on screen.
   */
  it("grows past the first group when two keys share it", () => {
    const victim = "@mira#563a-f056-c114-728a";
    const ground = "@mira#563a-8992-08c4-700c";
    const onScreen = [victim, ground];

    expect(displayTag(victim, onScreen)).toBe("@mira#563a-f056");
    expect(displayTag(ground, onScreen)).toBe("@mira#563a-8992");
  });

  it("keeps growing when a grinder buys more groups", () => {
    const victim = "@mira#563a-f056-c114-728a";
    const closer = "@mira#563a-f056-c114-0000";
    const onScreen = [victim, closer];

    // 48 bits ground is not a plausible laptop afternoon, but the shortening does not depend
    // on that being true — it depends on never returning a prefix two keys on screen share.
    expect(displayTag(victim, onScreen)).toBe("@mira#563a-f056-c114-728a");
    expect(displayTag(closer, onScreen)).toBe("@mira#563a-f056-c114-0000");
  });

  it("says the bare name when nobody on screen is competing for it", () => {
    const only = "@mira#563a-f056-c114-728a";
    expect(displayTag(only, [only, "@robin#0000-1111-2222-3333"])).toBe("@mira");
  });
});
