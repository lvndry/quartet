/**
 * @fileoverview What happens when more than one key answers to one name.
 *
 * `known.test.ts` covers the pin file's own decisions. This covers the two places those
 * decisions are spent, both of which live somewhere else: the refusal in `invite`, and the
 * label set that decides how much fingerprint gets written.
 *
 * The bridge is built but never started, and its directory stays empty on purpose. That is
 * not a shortcut — an empty directory beside a populated pin file *is* the attack. The hub
 * chooses what a directory frame contains, so a check that reads only the directory can be
 * silenced by omission; every assertion here therefore has to survive on pins alone.
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

const HUB = "https://tech.example";
let workDir: string;
let files = 0;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "quartet-collision-"));
  setIdentityDirectory(workDir);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A bridge with nothing but a pin file: no hub reachable, no directory, no connections. */
async function bridgeKnowing(pins: readonly [string, string][], hub = HUB): Promise<Bridge> {
  files += 1;
  const known = new KnownKeys(hub, join(workDir, `known-${String(files)}.json`));
  await known.load();
  for (const [did, handle] of pins) known.offer(did, handle);
  return new Bridge(
    hub,
    { url: "http://127.0.0.1:1", webhook: "quartet", webhookToken: "t" },
    new Attestor(generateKeypair()),
    new Sealer({ current: generateSealingKeypair(), retired: [] }),
    known,
  );
}

describe("inviting by a name more than one key answers to", () => {
  it("refuses a bare handle even when the hub is listing only one of them", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const bridge = await bridgeKnowing([
      [mira.did, "mira"],
      [alsoMira.did, "mira"],
    ]);

    // The directory is empty, so a guard reading only the directory sees no ambiguity at all
    // — which is precisely what a hub arranges by dropping the @mira you know at the moment
    // it lists a stranger wearing the name. The pins are what it cannot withdraw.
    const refusal = bridge.invite("@mira", "talk about the deposit");
    expect(refusal?.error).toContain("2 keys go by @mira");
    expect(refusal?.error).toContain(fingerprint(mira.did) ?? "");
    expect(refusal?.error).toContain(fingerprint(alsoMira.did) ?? "");
  });

  it("says which of them the hub is not currently mentioning", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const bridge = await bridgeKnowing([
      [mira.did, "mira"],
      [alsoMira.did, "mira"],
    ]);

    // Offline and being-hidden want opposite reactions from the person reading it, so the
    // refusal does not flatten them into one list of equals.
    const refusal = bridge.invite("@mira", "hello");
    expect(refusal?.error).toContain("not listed here right now");
  });

  it("lets a name only one key answers to through to the ordinary path", async () => {
    const robin = generateKeypair();
    const bridge = await bridgeKnowing([[robin.did, "robin"]]);

    // Not a refusal about ambiguity — it gets as far as needing a key from the hub, which is
    // the next check along and proof this one stood aside.
    const refusal = bridge.invite("@robin", "hello");
    expect(refusal?.error).not.toContain("go by @robin");
    expect(refusal?.error).toContain("no key for @robin");
  });

  it("does not refuse when the person already said which key they meant", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const bridge = await bridgeKnowing([
      [mira.did, "mira"],
      [alsoMira.did, "mira"],
    ]);

    // A fingerprint is independent knowledge, so ambiguity is already settled and the
    // question "say which" would be asking something the person just answered.
    const refusal = bridge.invite(`@mira#${fingerprint(mira.did) ?? ""}`, "hello");
    expect(refusal?.error).not.toContain("go by @mira");
  });

  it("keeps another hub's @mira out of it", async () => {
    const techMira = generateKeypair();
    const sportMira = generateKeypair();
    files += 1;
    const path = join(workDir, `known-shared-${String(files)}.json`);

    const onTech = new KnownKeys("https://tech.example", path);
    await onTech.load();
    onTech.offer(techMira.did, "mira");
    await onTech.repin(techMira.did, "mira");

    const onSport = new KnownKeys("https://sport.example", path);
    await onSport.load();
    onSport.offer(sportMira.did, "mira");
    await onSport.repin(sportMira.did, "mira");

    const bridge = new Bridge(
      "https://sport.example",
      { url: "http://127.0.0.1:1", webhook: "quartet", webhookToken: "t" },
      new Attestor(generateKeypair()),
      new Sealer({ current: generateSealingKeypair(), retired: [] }),
      onSport,
    );

    // The case that made all of this worth rewriting: one @mira in the tech hub and a
    // different @mira in the sport hub is two people, not an impersonation, and a bridge
    // that asked "say which" here would be asking about somebody unreachable from this hub.
    const refusal = bridge.invite("@mira", "hello");
    expect(refusal?.error).not.toContain("go by @mira");
  });
});

describe("how much fingerprint a contested name is written with", () => {
  it("qualifies both keys even when the hub lists neither", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const bridge = await bridgeKnowing([
      [mira.did, "mira"],
      [alsoMira.did, "mira"],
    ]);

    const { labels, fingerprints } = bridge.snapshot();
    // `displayTag` lengthens only against keys it can see, so a key missing from the label
    // set is a key nothing gets separated from — and the survivor would render bare.
    expect(labels[mira.did]).toStartWith("@mira#");
    expect(labels[alsoMira.did]).toStartWith("@mira#");
    expect(labels[mira.did]).not.toBe(labels[alsoMira.did]);
    expect(fingerprints[mira.did]).toBe(fingerprint(mira.did));
  });

  it("reaches into the pin file for contested names only, not all of it", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const robin = generateKeypair();
    const bridge = await bridgeKnowing([
      [mira.did, "mira"],
      [alsoMira.did, "mira"],
      [robin.did, "robin"],
    ]);

    const state = bridge.snapshot();
    // Pouring the whole pin file into the names on screen would put strangers in the set
    // that decides how long a fingerprint has to be, lengthening everybody's against keys
    // nobody can see.
    expect(state.labels[robin.did]).toBeUndefined();
    expect(state.fingerprints[robin.did]).toBeUndefined();
  });

  it("grows past the first group when two keys share it", () => {
    // Four hex digits is sixteen bits, and grinding a key whose fingerprint opens with a
    // chosen group costs about 65k keygens — a few seconds, measured. That is survivable
    // only because the short form is not a fixed four digits.
    const victim = "@mira#563a-f056-c114-728a";
    const ground = "@mira#563a-8992-08c4-700c";
    expect(displayTag(victim, [victim, ground])).toBe("@mira#563a-f056");
    expect(displayTag(ground, [victim, ground])).toBe("@mira#563a-8992");
  });

  it("says the bare name when nobody on screen is competing for it", () => {
    const only = "@mira#563a-f056-c114-728a";
    expect(displayTag(only, [only, "@robin#0000-1111-2222-3333"])).toBe("@mira");
  });
});
