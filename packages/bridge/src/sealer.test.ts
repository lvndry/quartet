import { describe, expect, it } from "bun:test";
import { generateSealingKeypair, packEnvelope, seal } from "@quartet/identity";
import { Sealer } from "./sealer";
import type { SealingKeys } from "./sealing-keys";

const ROOM = "cnv_6aa49acb";

function keys(overrides: Partial<SealingKeys> = {}): SealingKeys {
  return { current: generateSealingKeypair(), retired: [], ...overrides };
}

describe("sealing a steer to yourself", () => {
  it("round-trips the words the person typed", () => {
    const sealer = new Sealer(keys());
    const sealed = sealer.toSelf("ask about the deposit before agreeing to anything", ROOM);

    expect(sealed).toBeDefined();
    expect(sealer.open(sealed ?? "", ROOM)).toEqual({
      state: "opened",
      text: "ask about the deposit before agreeing to anything",
    });
  });

  it("does not leave the words in what the hub is handed", () => {
    // The whole claim of a sealed steer, asserted rather than assumed: the blob crossing the
    // wire has to contain none of it.
    const sealer = new Sealer(keys());
    const sealed = sealer.toSelf("my budget is really 400 but open at 550", ROOM) ?? "";

    expect(sealed).not.toContain("budget");
    expect(sealed).not.toContain("550");
  });

  it("stays shut for a different agent's keys", () => {
    const mine = new Sealer(keys());
    const theirs = new Sealer(keys());
    const sealed = mine.toSelf("this is between me and my agent", ROOM) ?? "";

    expect(theirs.open(sealed, ROOM).state).toBe("sealed-to-others");
  });

  it("refuses loudly when a steer arrives against a different conversation", () => {
    // The hub picks which room a steer comes back on, so filing one against another room is
    // the cheapest confusion it could cause. It is addressed to this agent either way, which
    // is exactly why the verdict is `unopenable` rather than `sealed-to-others`: a line meant
    // for me that will not open is the loud case, not the ordinary one.
    const sealer = new Sealer(keys());
    const sealed = sealer.toSelf("stall until Friday", ROOM) ?? "";

    expect(sealer.open(sealed, "cnv_another").state).toBe("unopenable");
  });
});

describe("opening what is sealed to a room", () => {
  it("opens a line sealed by somebody else to this agent", () => {
    const mira = new Sealer(keys());
    const sam = new Sealer(keys());
    const sealed = mira.toRoom("Thursday then", [sam.sealingDid], ROOM) ?? "";

    expect(sam.open(sealed, ROOM)).toEqual({ state: "opened", text: "Thursday then" });
    // The author keeps its own copy: a room it cannot read back is a room it has lost.
    expect(mira.open(sealed, ROOM)).toEqual({ state: "opened", text: "Thursday then" });
  });

  it("reads history sealed to a key that has since been retired", () => {
    const old = generateSealingKeypair();
    const sealer = new Sealer(keys({ retired: [old] }));

    const envelope = seal("said before the rotation", [old.sealingDid], ROOM);
    expect(sealer.open(packEnvelope(envelope!), ROOM)).toEqual({
      state: "opened",
      text: "said before the rotation",
    });
  });

  it("separates a room joined late from a line that is damaged", () => {
    const sealer = new Sealer(keys());
    const stranger = generateSealingKeypair();

    // Sealed to somebody else entirely: ordinary, and what every line written before you
    // joined looks like.
    const others = packEnvelope(seal("before your time", [stranger.sealingDid], ROOM)!);
    expect(sealer.open(others, ROOM).state).toBe("sealed-to-others");

    // Sealed to this agent and still refusing to open: that is damage or forgery.
    const mine = seal("for you", [sealer.sealingDid], ROOM)!;
    const corrupted = packEnvelope({ ...mine, ct: Buffer.from("nonsense").toString("base64") });
    expect(sealer.open(corrupted, ROOM).state).toBe("unopenable");
  });

  it("calls plaintext unopenable rather than passing it through", () => {
    // What a pre-encryption build would have sent. Reading it would mean a hub could strip
    // the sealing off any line and have it accepted in the clear.
    const sealer = new Sealer(keys());

    expect(sealer.open("just some words", ROOM).state).toBe("unopenable");
    expect(sealer.open("", ROOM).state).toBe("unopenable");
  });
});
