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

describe("pinning the key behind a handle", () => {
  it("takes the first answer and holds it against every later one", async () => {
    const mira = generateKeypair();
    const impostor = generateKeypair();
    const known = new KnownKeys();
    await known.load();

    expect(known.offer("mira", mira.did)).toBeUndefined();
    expect(known.did("mira")).toBe(mira.did);

    // The same key again is not news, however many times a hub repeats it.
    expect(known.offer("mira", mira.did)).toBeUndefined();

    const conflict = known.offer("mira", impostor.did);
    expect(conflict).toEqual({ handle: "mira", pinned: mira.did, offered: impostor.did });
    // The pin does not move. A hub does not get to replace a checked key by asserting louder.
    expect(known.did("mira")).toBe(mira.did);
    expect(known.all()).toHaveLength(1);
  });

  it("moves the pin only when somebody decides it should", async () => {
    const mira = generateKeypair();
    const replacement = generateKeypair();
    const known = new KnownKeys();
    await known.load();

    known.offer("mira", mira.did);
    known.offer("mira", replacement.did);
    await known.repin("mira", replacement.did);

    expect(known.did("mira")).toBe(replacement.did);
    expect(known.all()).toHaveLength(0);
  });

  it("survives a restart, which is the only reason it is on disk", async () => {
    const mira = generateKeypair();
    const first = new KnownKeys();
    await first.load();
    first.offer("mira", mira.did);
    // `offer` saves in the background; `repin` awaits, so it is what settles the file.
    await first.repin("mira", mira.did);

    const second = new KnownKeys();
    await second.load();

    expect(second.did("mira")).toBe(mira.did);
    expect(second.offer("mira", generateKeypair().did)).toBeDefined();
  });

  it("will not quietly re-pin over a file it could not read", async () => {
    await Bun.write(join(workDir, "known.json"), "{ not json at all");
    const known = new KnownKeys();
    await known.load();

    expect(known.did("mira")).toBeUndefined();
    expect(known.problem()).toContain("could not be read");

    // The dangerous move would be treating this like a first run and pinning whatever the
    // hub offers next — a free key swap at the one moment nothing is left to contradict it.
    const impostor = generateKeypair();
    expect(known.offer("mira", impostor.did)).toBeUndefined();
    expect(known.did("mira")).toBeUndefined();

    // A person deciding beats an unreadable file, so that is also how somebody recovers.
    const real = generateKeypair();
    await known.repin("mira", real.did);
    expect(known.problem()).toBeUndefined();
    expect(known.did("mira")).toBe(real.did);
  });
});
