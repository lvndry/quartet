import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claimDatabase, databaseForName, quartetHome, slugForName } from "./naming";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  delete process.env["QUARTET_HOME"];
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "quartet-naming-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("a name becomes a filename", () => {
  it("keeps two differently-spelled names apart and two spellings of one name together", () => {
    expect(slugForName("friday night")).toBe("friday-night");
    expect(slugForName("  Friday   Night  ")).toBe("friday-night");
    expect(slugForName("Friday-Night!")).toBe("friday-night");
    expect(slugForName("work")).not.toBe(slugForName("works"));
  });

  /**
   * The property the whole scheme rests on: a name has to survive the round trip to a file
   * and back on the next restart. A slug that varied by run would file each start of the same
   * hub somewhere new, which is the bug this replaced wearing different clothes.
   */
  it("is stable across calls", () => {
    expect(slugForName("friday night")).toBe(slugForName("friday night"));
  });

  it("refuses a name with nothing filename-shaped in it rather than inventing one", () => {
    expect(slugForName("🎷")).toBeUndefined();
    expect(slugForName("!!!")).toBeUndefined();
    expect(slugForName("   ")).toBeUndefined();
  });

  it("never escapes the hubs directory, whatever the name tries", () => {
    for (const hostile of ["../../etc/passwd", "..", "a/b", "~/root"]) {
      const slug = slugForName(hostile);
      expect(slug === undefined || (!slug.includes("/") && !slug.includes(".."))).toBe(true);
    }
  });
});

describe("where a hub keeps its state", () => {
  it("files it under the data directory, not the working directory", () => {
    process.env["QUARTET_HOME"] = "/somewhere/else";
    expect(databaseForName("friday night")).toBe("/somewhere/else/hubs/friday-night.sqlite");
  });

  it("defaults to the same ~/.quartet the rest of quartet uses", () => {
    expect(quartetHome()).toBe(join(homedir(), ".quartet"));
  });

  it("gives two names two databases", () => {
    process.env["QUARTET_HOME"] = "/somewhere/else";
    expect(databaseForName("work")).not.toBe(databaseForName("friday night"));
  });
});

describe("only one hub at a time may hold a database", () => {
  it("grants the claim and cleans up after itself", () => {
    const path = join(workDir(), "hub.sqlite");
    const claim = claimDatabase(path);
    expect(claim.kind).toBe("held");
    expect(existsSync(`${path}.lock`)).toBe(true);
    if (claim.kind === "held") claim.release();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("reports the holder rather than opening the same database twice", () => {
    const path = join(workDir(), "hub.sqlite");
    const first = claimDatabase(path);
    expect(first.kind).toBe("held");
    const claim = claimDatabase(path);
    expect(claim.kind).toBe("taken");
    if (claim.kind === "taken") expect(claim.pid).toBe(process.pid);
    if (first.kind === "held") first.release();
  });

  it("takes over a lock left by a previous container with a recycled pid", () => {
    const path = join(workDir(), "hub.sqlite");
    // Simulate a prior deploy: lock file still says our pid number, but this process never
    // claimed it — the usual Railway/Docker case after restart as pid 1 again.
    writeFileSync(`${path}.lock`, String(process.pid), "utf8");
    const claim = claimDatabase(path);
    expect(claim.kind).toBe("held");
    if (claim.kind === "held") claim.release();
  });

  /**
   * A hub killed with SIGKILL leaves its lock behind. Refusing to start because of your own
   * previous crash means somebody has to know to go and delete a file, which is not a thing
   * anybody knows at the moment they need to.
   */
  it("takes over a lock whose process is gone", () => {
    const path = join(workDir(), "hub.sqlite");
    // Every pid is taken at some point, but not one above the platform ceiling.
    writeFileSync(`${path}.lock`, "4294967295", "utf8");
    const claim = claimDatabase(path);
    expect(claim.kind).toBe("held");
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(String(process.pid));
    if (claim.kind === "held") claim.release();
  });

  it("takes over a lock it cannot make sense of", () => {
    const path = join(workDir(), "hub.sqlite");
    writeFileSync(`${path}.lock`, "not a pid", "utf8");
    expect(claimDatabase(path).kind).toBe("held");
  });

  /**
   * Releasing has to be idempotent and has to check ownership: the handler is registered on
   * `exit` and may also be called directly, and a release that deleted whatever lock it found
   * would hand the database to a third hub that had legitimately taken over.
   */
  it("does not delete a lock that has since become somebody else's", () => {
    const path = join(workDir(), "hub.sqlite");
    const claim = claimDatabase(path);
    expect(claim.kind).toBe("held");
    writeFileSync(`${path}.lock`, "4242", "utf8");
    if (claim.kind === "held") {
      claim.release();
      claim.release();
    }
    expect(readFileSync(`${path}.lock`, "utf8")).toBe("4242");
  });
});
