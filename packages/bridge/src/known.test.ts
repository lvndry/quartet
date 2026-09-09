import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, generateKeypair, parseTag, tag } from "@quartet/identity";
import { KnownKeys } from "./known";

const HUB = "https://tech.example";
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
    const known = new KnownKeys(HUB);
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
    // A rename that did not land cannot have put a second key on the name it was refused.
    expect(known.wearersOf("robin")).toEqual([]);
  });

  it("says nothing at all about a key and a name it has never seen either of", async () => {
    const mira = generateKeypair();
    const known = new KnownKeys(HUB);
    await known.load();

    expect(known.offer(mira.did, "mira")).toBeUndefined();
    expect(known.handleOf(mira.did)).toBe("mira");
    expect(known.all()).toEqual([]);
    // One key on a name is not two keys on a name, and this is the ordinary case: almost
    // every offer this bridge ever makes is somebody's first sighting of somebody.
    expect(known.wearersOf("mira")).toEqual([mira.did]);
    expect(known.contestedNames()).toEqual([]);
  });

  it("pins a second key on one name without calling it a conflict, and says so", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const known = new KnownKeys(HUB);
    await known.load();

    expect(known.offer(mira.did, "mira")).toBeUndefined();

    // The case that is not the alarm. A handle is a label, and friends pick the same ones —
    // crying `Conflict` here would train somebody to click through the real warning. So the
    // second key is pinned, nothing is refused, and no conflict is recorded.
    expect(known.offer(alsoMira.did, "mira")).toBeUndefined();
    expect(known.all()).toEqual([]);
    expect(known.handleOf(mira.did)).toBe("mira");
    expect(known.handleOf(alsoMira.did)).toBe("mira");

    // What the second key buys is an entry in the index, which is what `invite` refuses on.
    // The signal belongs where somebody acts on the name, not on a banner beside it.
    expect(known.wearersOf("mira")).toEqual([mira.did, alsoMira.did].sort());
  });

  it("keeps repeating itself, because the fact does not stop being true", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const known = new KnownKeys(HUB);
    await known.load();

    known.offer(mira.did, "mira");
    known.offer(alsoMira.did, "mira");

    // A hub relists the directory constantly, and neither key is new the second time round,
    // so no further offer is news. The standing fact is read off the index, not latched when
    // it happened — otherwise a restart would drop the note with both keys still on file.
    expect(known.offer(mira.did, "mira")).toBeUndefined();
    expect(known.offer(alsoMira.did, "mira")).toBeUndefined();
    expect(known.wearersOf("mira")).toEqual([mira.did, alsoMira.did].sort());
  });

  it("counts a third, and keeps names it has only one key for out of it", async () => {
    const [mira, alsoMira, thirdMira, robin] = [
      generateKeypair(),
      generateKeypair(),
      generateKeypair(),
      generateKeypair(),
    ];
    const known = new KnownKeys(HUB);
    await known.load();

    known.offer(mira.did, "mira");
    known.offer(alsoMira.did, "mira");
    known.offer(robin.did, "robin");

    expect(known.offer(thirdMira.did, "mira")).toBeUndefined();
    expect(known.wearersOf("mira")).toEqual([mira.did, alsoMira.did, thirdMira.did].sort());
    // A name only one key wears stays out of the contested set entirely.
    expect(known.contestedNames()).toEqual([
      { handle: "mira", dids: [mira.did, alsoMira.did, thirdMira.did].sort() },
    ]);
  });

  it("still knows two keys wear one name after a restart", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const first = new KnownKeys(HUB);
    await first.load();
    first.offer(mira.did, "mira");
    first.offer(alsoMira.did, "mira");
    // `offer` saves in the background; `repin` awaits, so it is what settles the file.
    await first.repin(alsoMira.did, "mira");

    // Rebuilt from the pins rather than stored beside them, so the two directions cannot
    // come back disagreeing about who wears what.
    const second = new KnownKeys(HUB);
    await second.load();
    expect(second.wearersOf("mira")).toEqual([mira.did, alsoMira.did].sort());
  });

  it("stops counting a key under a name it has been re-pinned off", async () => {
    const mira = generateKeypair();
    const alsoMira = generateKeypair();
    const known = new KnownKeys(HUB);
    await known.load();

    known.offer(mira.did, "mira");
    known.offer(alsoMira.did, "mira");
    known.offer(alsoMira.did, "robin");
    await known.repin(alsoMira.did, "robin");

    // A phantom second @mira would be the worst version of this: `invite` would refuse a
    // name over a key that has stopped answering to it, and nothing a person did could clear
    // it.
    expect(known.wearersOf("mira")).toEqual([mira.did]);
    expect(known.handleOf(mira.did)).toBe("mira");
    expect(known.handleOf(alsoMira.did)).toBe("robin");
  });

  it("treats a file that parses but is not a pin map as damaged, not as empty", async () => {
    // Only a *parse* error used to set this, so `null` or `[1,2,3]` read as a first run —
    // every pin silently gone, no signal, at the one moment nothing is left to contradict a
    // hub. Valid JSON in the wrong shape still means pins existed and cannot be used.
    for (const junk of ["null", "[1,2,3]", '"a string"']) {
      const path = join(workDir, `junk-${junk.length}-${String(junk.charCodeAt(1))}.json`);
      await Bun.write(path, junk);
      const known = new KnownKeys(HUB, path);
      await known.load();
      expect(known.problem()).toBeDefined();
    }
  });

  it("moves the pin only when somebody decides it should", async () => {
    const mira = generateKeypair();
    const known = new KnownKeys(HUB);
    await known.load();

    known.offer(mira.did, "mira");
    known.offer(mira.did, "robin");
    await known.repin(mira.did, "robin");

    expect(known.handleOf(mira.did)).toBe("robin");
    expect(known.all()).toHaveLength(0);
  });

  it("survives a restart, which is the only reason it is on disk", async () => {
    const mira = generateKeypair();
    const first = new KnownKeys(HUB);
    await first.load();
    first.offer(mira.did, "mira");
    // `offer` saves in the background; `repin` awaits, so it is what settles the file.
    await first.repin(mira.did, "mira");

    const second = new KnownKeys(HUB);
    await second.load();

    expect(second.handleOf(mira.did)).toBe("mira");
    expect(second.offer(mira.did, "robin")).toBeDefined();
  });

  it("keeps each hub's names to itself, because a handle is one hub's row", async () => {
    const techMira = generateKeypair();
    const sportMira = generateKeypair();
    const path = join(workDir, "two-hubs.json");

    const onTech = new KnownKeys("https://tech.example", path);
    await onTech.load();
    onTech.offer(techMira.did, "mira");
    await onTech.repin(techMira.did, "mira");

    const onSport = new KnownKeys("https://sport.example", path);
    await onSport.load();
    // A different person, on a different hub, who also picked the commonest name there is.
    // Pooling the two would make this an ambiguity to resolve; it is simply two people.
    expect(onSport.offer(sportMira.did, "mira")).toBeUndefined();
    expect(onSport.wearersOf("mira")).toEqual([sportMira.did]);
    expect(onSport.handleOf(techMira.did)).toBeUndefined();
    expect(onSport.contestedNames()).toEqual([]);
  });

  it("does not let one hub raise a rename alarm about another hub's key", async () => {
    const mira = generateKeypair();
    const path = join(workDir, "no-cross-alarm.json");

    const onSport = new KnownKeys("https://sport.example", path);
    await onSport.load();
    // The poisoning move: public keys are public, so a hostile hub can assert a key it has
    // never met wearing a name of its choosing, for free.
    await onSport.repin(mira.did, "robin");

    const onTech = new KnownKeys("https://tech.example", path);
    await onTech.load();
    // On the hub that actually knows her, the legitimate listing is a first sighting — not
    // the vermilion "this key changed its name" alarm about a correspondent who did nothing.
    expect(onTech.offer(mira.did, "mira")).toBeUndefined();
    expect(onTech.all()).toEqual([]);
    expect(onTech.handleOf(mira.did)).toBe("mira");
  });

  it("saves one hub's pins without erasing the others", async () => {
    const techMira = generateKeypair();
    const sportRobin = generateKeypair();
    const path = join(workDir, "both-kept.json");

    const onTech = new KnownKeys("https://tech.example", path);
    await onTech.load();
    await onTech.repin(techMira.did, "mira");

    const onSport = new KnownKeys("https://sport.example", path);
    await onSport.load();
    await onSport.repin(sportRobin.did, "robin");

    // One file, many hubs. A save that wrote only its own slice would silently drop every
    // pin belonging to the hub the user happened not to be on, which is a key swap handed
    // out for free on their next visit.
    const reread = new KnownKeys("https://tech.example", path);
    await reread.load();
    expect(reread.handleOf(techMira.did)).toBe("mira");
    expect(reread.problem()).toBeUndefined();
  });

  it("fails closed on a pin file from before names recorded their hub", async () => {
    const mira = generateKeypair();
    // The old shape: did → handle at the top level, with no hub above it.
    await Bun.write(join(workDir, "legacy.json"), JSON.stringify({ [mira.did]: "mira" }));
    const known = new KnownKeys(HUB, join(workDir, "legacy.json"));
    await known.load();

    // Attributing those pins to whichever hub happens to be connected would import another
    // hub's names into this one — the exact conflation the hub dimension exists to end. So
    // they are refused rather than adopted, and a person is told why.
    expect(known.problem()).toContain("older build");
    expect(known.handleOf(mira.did)).toBeUndefined();
    expect(known.offer(mira.did, "mira")).toBeUndefined();
  });

  it("will not quietly re-pin over a file it could not read", async () => {
    await Bun.write(join(workDir, "known.json"), "{ not json at all");
    const known = new KnownKeys(HUB);
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
    expect(known.wearersOf("mira")).toEqual([]);

    // A person deciding beats an unreadable file, so that is also how somebody recovers.
    await known.repin(mira.did, "mira");
    expect(known.problem()).toBeUndefined();
    expect(known.handleOf(mira.did)).toBe("mira");
  });
});
