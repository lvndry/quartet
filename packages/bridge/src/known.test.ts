import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, generateKeypair, parseTag, tag } from "@quartet/identity";
import { KnownKeys } from "./known";
import { setIdentityDirectory } from "./paths";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "quartet-known-"));
  setIdentityDirectory(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("reading a handle somebody handed you", () => {
  it("takes both the bare handle and the form with a fingerprint on it", () => {
    const { did } = generateKeypair();
    const written = tag("mira", did);

    expect(parseTag("@mira")).toEqual({ handle: "mira" });
    expect(parseTag("mira")).toEqual({ handle: "mira" });
    expect(parseTag(written ?? "")).toEqual({
      handle: "mira",
      fingerprint: fingerprint(did) ?? "",
    });
  });

  it("turns down what is not a handle at all", () => {
    expect(parseTag("")).toBeUndefined();
    expect(parseTag("@Mira")).toBeUndefined();
    expect(parseTag("@mira#nonsense")).toBeUndefined();
    expect(parseTag("@mira#4f2a-9b31")).toBeUndefined();
  });
});

describe("remembering what a key calls itself", () => {
  it("takes the first name and holds it against every later one", async () => {
    const mira = generateKeypair();
    const known = new KnownKeys();
    await known.load();

    expect(known.offer(mira.did, "mira")).toBeUndefined();
    expect(known.handleOf(mira.did)).toBe("mira");

    // The same name again is not news, however many times a hub repeats it.
    expect(known.offer(mira.did, "mira")).toBeUndefined();

    const notice = known.offer(mira.did, "robin");
    expect(notice).toEqual({
      kind: "renamed",
      conflict: { did: mira.did, known: "mira", offered: "robin" },
    });
    // The pin does not move. A hub does not get to rename somebody by asserting louder.
    expect(known.handleOf(mira.did)).toBe("mira");
    expect(known.all()).toHaveLength(1);
    // A rename that did not land cannot have put a second key on the name it was refused.
    expect(known.sharedHandles()).toEqual([]);
  });

  it("says nothing at all about a key and a name it has never seen either of", async () => {
    const mira = generateKeypair();
    const known = new KnownKeys();
    await known.load();

    expect(known.offer(mira.did, "mira")).toBeUndefined();
    expect(known.handleOf(mira.did)).toBe("mira");
    expect(known.all()).toEqual([]);
    // One key on a name is not two keys on a name, and this is the ordinary case: almost
    // every offer this bridge ever makes is somebody's first sighting of somebody.
    expect(known.sharedHandles()).toEqual([]);
  });

  it("pins a second key on one name without calling it a conflict, and says so", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const known = new KnownKeys();
    await known.load();

    expect(known.offer(mira.did, "mira")).toBeUndefined();

    // The case that is not the alarm. A handle is a label, and friends pick the same ones —
    // crying `Conflict` here would train somebody to click through the real warning. So the
    // second key is pinned, nothing is refused, and no conflict is recorded.
    const notice = known.offer(alsoMira.did, "mira");
    expect(notice).toEqual({
      kind: "shared",
      shared: { handle: "mira", dids: [mira.did, alsoMira.did].sort() },
    });
    expect(known.all()).toEqual([]);
    expect(known.handleOf(mira.did)).toBe("mira");
    expect(known.handleOf(alsoMira.did)).toBe("mira");

    // The note names both keys, because a person told only that somebody else is already
    // @mira has the alarm and nothing to check it against.
    expect(known.sharedHandles()).toEqual([
      { handle: "mira", dids: [mira.did, alsoMira.did].sort() },
    ]);
  });

  it("keeps repeating itself, because the fact does not stop being true", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const known = new KnownKeys();
    await known.load();

    known.offer(mira.did, "mira");
    known.offer(alsoMira.did, "mira");

    // A hub relists the directory constantly, and neither key is new the second time round,
    // so no further offer is news. The standing fact is read off the index, not latched when
    // it happened — otherwise a restart would drop the note with both keys still on file.
    expect(known.offer(mira.did, "mira")).toBeUndefined();
    expect(known.offer(alsoMira.did, "mira")).toBeUndefined();
    expect(known.sharedHandles()).toEqual([
      { handle: "mira", dids: [mira.did, alsoMira.did].sort() },
    ]);
  });

  it("counts a third, and keeps names it has only one key for out of it", async () => {
    const [mira, alsoMira, thirdMira, robin] = [
      generateKeypair(),
      generateKeypair(),
      generateKeypair(),
      generateKeypair(),
    ];
    const known = new KnownKeys();
    await known.load();

    known.offer(mira.did, "mira");
    known.offer(alsoMira.did, "mira");
    known.offer(robin.did, "robin");

    const notice = known.offer(thirdMira.did, "mira");
    expect(notice?.kind).toBe("shared");
    expect(known.sharedHandles()).toEqual([
      { handle: "mira", dids: [mira.did, alsoMira.did, thirdMira.did].sort() },
    ]);
  });

  it("still knows two keys wear one name after a restart", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const first = new KnownKeys();
    await first.load();
    first.offer(mira.did, "mira");
    first.offer(alsoMira.did, "mira");
    // `offer` saves in the background; `repin` awaits, so it is what settles the file.
    await first.repin(alsoMira.did, "mira");

    // Rebuilt from the pins rather than stored beside them, so the two directions cannot
    // come back disagreeing about who wears what.
    const second = new KnownKeys();
    await second.load();
    expect(second.sharedHandles()).toEqual([
      { handle: "mira", dids: [mira.did, alsoMira.did].sort() },
    ]);
  });

  it("stops counting a key under a name it has been re-pinned off", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const known = new KnownKeys();
    await known.load();

    known.offer(mira.did, "mira");
    known.offer(alsoMira.did, "mira");
    known.offer(alsoMira.did, "robin");
    await known.repin(alsoMira.did, "robin");

    // A phantom second @mira would be the worst version of this note: an alarm about a key
    // that has stopped answering to the name, which nothing a person did could clear.
    expect(known.sharedHandles()).toEqual([]);
    expect(known.handleOf(mira.did)).toBe("mira");
    expect(known.handleOf(alsoMira.did)).toBe("robin");
  });

  it("moves the pin only when somebody decides it should", async () => {
    const mira = generateKeypair();
    const known = new KnownKeys();
    await known.load();

    known.offer(mira.did, "mira");
    known.offer(mira.did, "robin");
    await known.repin(mira.did, "robin");

    expect(known.handleOf(mira.did)).toBe("robin");
    expect(known.all()).toHaveLength(0);
  });

  it("survives a restart, which is the only reason it is on disk", async () => {
    const mira = generateKeypair();
    const first = new KnownKeys();
    await first.load();
    first.offer(mira.did, "mira");
    // `offer` saves in the background; `repin` awaits, so it is what settles the file.
    await first.repin(mira.did, "mira");

    const second = new KnownKeys();
    await second.load();

    expect(second.handleOf(mira.did)).toBe("mira");
    expect(second.offer(mira.did, "robin")?.kind).toBe("renamed");
  });

  it("will not quietly re-pin over a file it could not read", async () => {
    await Bun.write(join(workDir, "known.json"), "{ not json at all");
    const known = new KnownKeys();
    await known.load();
    const mira = generateKeypair();

    expect(known.handleOf(mira.did)).toBeUndefined();
    expect(known.problem()).toContain("could not be read");

    // The dangerous move would be treating this like a first run and pinning whatever the
    // hub offers next — a free rename at the one moment nothing is left to contradict it.
    expect(known.offer(mira.did, "mira")).toBeUndefined();
    expect(known.handleOf(mira.did)).toBeUndefined();

    // Nor does it invent the other signal out of a file it cannot read. Nothing is pinned,
    // so nothing wears a name here, so nobody shares one.
    expect(known.offer(generateKeypair().did, "mira")).toBeUndefined();
    expect(known.sharedHandles()).toEqual([]);

    // A person deciding beats an unreadable file, so that is also how somebody recovers.
    await known.repin(mira.did, "mira");
    expect(known.problem()).toBeUndefined();
    expect(known.handleOf(mira.did)).toBe("mira");
  });
});
