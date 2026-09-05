import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Attestor } from "./attest";
import { Bridge } from "./bridge";
import { Sealer } from "./sealer";
import { setIdentityDirectory } from "./paths";
import { generateKeypair, generateSealingKeypair } from "@quartet/identity";

// An Attestor opens this identity's journal, so it needs a directory to open it in. A
// throwaway one: with no identity chosen there is no default any more, which is the point —
// the default used to be the operator's real `~/.quartet`, and this suite wrote into it.
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "quartet-progress-"));
  setIdentityDirectory(workDir);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function bridge(): Bridge {
  return new Bridge(
    "http://127.0.0.1:1",
    { url: "http://127.0.0.1:1", webhook: "quartet", token: "t" },
    new Attestor(generateKeypair()),
    new Sealer({ current: generateSealingKeypair(), retired: [] }),
  );
}

describe("the daemon reporting into a turn", () => {
  it("refuses a key no turn is waiting on", () => {
    // The progress endpoint has no browser token, because the daemon has none. What stops
    // anything else on this machine narrating the room is that the key is one only the
    // daemon was given, for one turn.
    expect(bridge().onDaemonProgress("not-a-key", { kind: "tool-started", toolName: "rm" })).toBe(
      false,
    );
  });

  it("refuses a key that has already been used up", () => {
    // Keys are dropped when their turn ends, so a daemon that keeps talking after it has
    // answered cannot leave a stale tool name sitting in the room.
    const subject = bridge();
    expect(subject.onDaemonProgress("", { kind: "tool-started", toolName: "ls" })).toBe(false);
  });
});
