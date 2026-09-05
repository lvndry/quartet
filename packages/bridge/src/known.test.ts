import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, generateKeypair, parseTag, tag } from "@quartet/identity";
import { KnownKeys } from "./known";
import { setDataDirectory } from "./paths";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "quartet-known-"));
  setDataDirectory(workDir);
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

    const conflict = known.offer(mira.did, "robin");
    expect(conflict).toEqual({ did: mira.did, known: "mira", offered: "robin" });
    // The pin does not move. A hub does not get to rename somebody by asserting louder.
    expect(known.handleOf(mira.did)).toBe("mira");
    expect(known.all()).toHaveLength(1);
  });

  it("says nothing when two different keys wear one name, because that is two people", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const known = new KnownKeys();
    await known.load();

    expect(known.offer(mira.did, "mira")).toBeUndefined();
    // The case that used to be the alarm. A handle is a label now, and friends pick the same
    // ones — crying wolf here would train somebody to click through the real warning.
    expect(known.offer(alsoMira.did, "mira")).toBeUndefined();
    expect(known.all()).toHaveLength(0);
    expect(known.handleOf(mira.did)).toBe("mira");
    expect(known.handleOf(alsoMira.did)).toBe("mira");
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
    expect(second.offer(mira.did, "robin")).toBeDefined();
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

    // A person deciding beats an unreadable file, so that is also how somebody recovers.
    await known.repin(mira.did, "mira");
    expect(known.problem()).toBeUndefined();
    expect(known.handleOf(mira.did)).toBe("mira");
  });
});
