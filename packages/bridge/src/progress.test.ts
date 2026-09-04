import { describe, expect, it } from "bun:test";
import { Attestor } from "./attest";
import { Bridge } from "./bridge";
import { Sealer } from "./sealer";
import { generateKeypair, generateSealingKeypair } from "@quartet/identity";

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
