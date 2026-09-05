import { describe, expect, it } from "bun:test";
import {
  generateKeypair,
  generateSealingKeypair,
  packEnvelope,
  seal,
  signSealingKey,
  type Keypair,
} from "@quartet/identity";
import type { Member, Message } from "@quartet/protocol";
import { recipientsFor, Sealer, withWords } from "./sealer";
import type { SealingKeys } from "./sealing-keys";

const ROOM = "cnv_6aa49acb";

function keys(overrides: Partial<SealingKeys> = {}): SealingKeys {
  return { current: generateSealingKeypair(), retired: [], ...overrides };
}

/** One member as the hub would relay them: a handle, a signing key, and a sealed-to key. */
function member(handle: string, signer: Keypair = generateKeypair()): Member {
  const at = "2026-02-02T10:00:00.000Z";
  const { sealingDid } = generateSealingKeypair();
  return {
    handle,
    did: signer.did,
    sealing: {
      sealingDid,
      at,
      proof: signSealingKey({ did: signer.did, sealingDid, at }, signer.privateKey),
    },
  };
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

describe("resolving who a room may be sealed to", () => {
  /** Everybody in the room is somebody this machine has seen before. */
  const allKnown = () => true;

  it("returns everybody but the sender", () => {
    // The sender is left out here and added by `toRoom`, so a room of three yields two keys.
    const room = [member("mira"), member("otto"), member("nia")];

    const resolved = recipientsFor(room, room[0]!.did, allKnown);

    expect(resolved.state).toBe("ready");
    expect(resolved.state === "ready" && resolved.sealingDids).toEqual([
      room[1]!.sealing!.sealingDid,
      room[2]!.sealing!.sealingDid,
    ]);
  });

  it("leaves out the sender by key, not by name", () => {
    // Two @mira in one room. Skipping by handle would drop the wrong one from the recipients
    // and seal the line away from somebody sitting in the room.
    const me = member("mira");
    const namesake = member("mira");
    const room = [me, namesake];

    const resolved = recipientsFor(room, me.did, allKnown);

    expect(resolved.state === "ready" && resolved.sealingDids).toEqual([
      namesake.sealing!.sealingDid,
    ]);
  });

  it("refuses the room rather than sealing to the members it can reach", () => {
    // The failure this exists to prevent. Sealing to otto alone would produce a line nia
    // reads as "written before I joined" — an ordinary sentence for a room that has silently
    // split in two.
    const room = [member("mira"), member("otto"), { handle: "nia", did: generateKeypair().did }];

    const resolved = recipientsFor(room, room[0]!.did, allKnown);

    expect(resolved.state).toBe("refused");
    expect(resolved.state === "refused" && resolved.why).toContain("@nia");
  });

  it("refuses a sealing key not signed by the key that member is identified by", () => {
    // An inconsistent frame: the sealing key is signed by something other than the did the
    // member is named by. Nothing legitimate produces this.
    const otto = generateKeypair();
    const impostor = generateKeypair();
    const at = "2026-02-02T10:00:00.000Z";
    const { sealingDid } = generateSealingKeypair();
    const room = [
      member("mira"),
      {
        handle: "otto",
        did: otto.did,
        sealing: {
          sealingDid,
          at,
          proof: signSealingKey({ did: otto.did, sealingDid, at }, impostor.privateKey),
        },
      },
    ];

    const resolved = recipientsFor(room, room[0]!.did, allKnown);

    expect(resolved.state).toBe("refused");
    expect(resolved.state === "refused" && resolved.why).toContain("@otto");
  });

  it("refuses a member whose key this machine has never seen", () => {
    // The check that stops a hub substituting a member wholesale. A did and a proof that
    // arrived in the same frame are self-consistent however hostile the frame is, so being
    // internally valid proves nothing — having been seen before is what proves something.
    const room = [member("mira"), member("otto")];

    const resolved = recipientsFor(room, room[0]!.did, (did) => did !== room[1]!.did);

    expect(resolved.state).toBe("refused");
    expect(resolved.state === "refused" && resolved.why).toContain("@otto");
  });

  it("has nobody to seal to in a room of one, and says so without refusing", () => {
    const room = [member("mira")];

    expect(recipientsFor(room, room[0]!.did, allKnown)).toEqual({
      state: "ready",
      sealingDids: [],
    });
  });
});

describe("handing a line to an agent", () => {
  const line = (text: string): Message => ({
    id: "msg_1",
    conversationId: ROOM,
    authorDid: generateKeypair().did,
    kind: "agent",
    text,
    at: "2026-02-02T10:00:00.000Z",
  });

  it("gives back the words when there are words", () => {
    expect(withWords(line("sealed"), { state: "opened", text: "Thursday then" }).text).toBe(
      "Thursday then",
    );
  });

  it("never hands on the ciphertext as if it were speech", () => {
    // The failure that would put an envelope into an agent's context as the other party's
    // words — which it would then answer, at the owner's expense.
    const stranger = generateSealingKeypair();
    const theirs = packEnvelope(seal("the deposit is negotiable", [stranger.sealingDid], ROOM)!);

    const shown = withWords(line(theirs), { state: "sealed-to-others" }).text;

    expect(shown).not.toContain("epk");
    expect(shown).not.toContain("recipients");
    expect(shown).toContain("before you joined");
  });

  it("says a line is missing rather than leaving a hole", () => {
    // Silence would have the agent answer a conversation with a gap in it as though the gap
    // were not there, which is the one thing worse than saying so.
    expect(withWords(line("sealed"), { state: "unopenable" }).text.length).toBeGreaterThan(0);
    expect(withWords(line("sealed"), { state: "unopenable" }).text).toContain("would not open");
  });

  it("leaves everything else about the line alone", () => {
    const sealed = line("sealed");
    const shown = withWords(sealed, { state: "opened", text: "hello" });

    expect(shown.id).toBe("msg_1");
    expect(shown.authorDid).toBe(sealed.authorDid);
    expect(shown.at).toBe("2026-02-02T10:00:00.000Z");
  });
});
