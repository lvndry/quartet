import { describe, expect, it } from "bun:test";
import {
  DOMAIN,
  base58Decode,
  base58Encode,
  canonical,
  didFromPublicKey,
  fingerprint,
  generateKeypair,
  isDid,
  newNonce,
  publicKeyFromDid,
  signChallenge,
  signClaim,
  signMessage,
  tag,
  verifyChallenge,
  verifyClaim,
  verifyMessage,
  type SignedMessage,
} from "./index";

function aMessage(overrides: Partial<SignedMessage> = {}): SignedMessage {
  return {
    did: "did:key:zPlaceholder",
    conversationId: "cnv_6aa49acb",
    kind: "agent",
    authoredAt: "2026-09-02T18:08:03.000Z",
    nonce: "n0",
    prev: "",
    dispatch: "dsp_6aa49acb",
    text: "I can do Thursday afternoon.",
    ...overrides,
  };
}

describe("base58btc", () => {
  it("round-trips arbitrary bytes", () => {
    for (const bytes of [[], [0], [0, 0, 1], [255, 254, 253], [1, 2, 3, 4, 5, 6, 7, 8, 9]]) {
      const input = Uint8Array.from(bytes);
      expect([...(base58Decode(base58Encode(input)) ?? [])]).toEqual(bytes);
    }
  });

  it("keeps leading zero bytes, which carry no value but are part of the key", () => {
    expect(base58Encode(Uint8Array.from([0, 0, 42]))).toStartWith("11");
    expect(base58Decode("11")).toEqual(Uint8Array.from([0, 0]));
  });

  it("refuses characters the alphabet leaves out to stop transcription slips", () => {
    for (const ambiguous of ["0", "O", "I", "l"]) {
      expect(base58Decode(`abc${ambiguous}`)).toBeUndefined();
    }
  });
});

describe("did:key", () => {
  it("round-trips a generated key through its did", () => {
    const { did } = generateKeypair();
    const raw = publicKeyFromDid(did);

    expect(did).toStartWith("did:key:z6Mk");
    expect(raw).toBeDefined();
    expect(raw?.length).toBe(32);
    expect(didFromPublicKey(raw ?? new Uint8Array())).toBe(did);
  });

  it("turns down anything that is not an Ed25519 did:key", () => {
    const { did } = generateKeypair();

    expect(isDid(did)).toBe(true);
    expect(isDid("did:web:example.com")).toBe(false);
    expect(isDid("did:key:zNotBase58_0OIl")).toBe(false);
    expect(isDid(`${did}extra`)).toBe(false);
    expect(isDid("")).toBe(false);
  });

  it("gives two different keys two different fingerprints, in a shape a person can read", () => {
    const one = generateKeypair();
    const other = generateKeypair();

    expect(fingerprint(one.did)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(fingerprint(one.did)).not.toBe(fingerprint(other.did));
    expect(fingerprint(one.did)).toBe(fingerprint(one.did));
    expect(tag("mira", one.did)).toBe(`@mira#${fingerprint(one.did)}`);
  });
});

describe("canonical bytes", () => {
  it("cannot be confused by a field that contains the separator", () => {
    const shifted = canonical(DOMAIN.message, ["a\n5:b", "c"]);
    const honest = canonical(DOMAIN.message, ["a", "5:b\nc"]);

    expect(shifted.equals(honest)).toBe(false);
  });

  it("separates domains, so a signature cannot be lifted from one use to another", () => {
    expect(canonical(DOMAIN.message, ["x"]).equals(canonical(DOMAIN.claim, ["x"]))).toBe(false);
  });
});

describe("signing a message", () => {
  it("verifies what was actually signed", () => {
    const { did, privateKey } = generateKeypair();
    const message = aMessage({ did });

    expect(verifyMessage(message, signMessage(message, privateKey))).toBe(true);
  });

  it("rejects every field a relaying hub could otherwise quietly rewrite", () => {
    const { did, privateKey } = generateKeypair();
    const message = aMessage({ did });
    const signature = signMessage(message, privateKey);

    const tampered: Partial<SignedMessage>[] = [
      { text: "I can do Thursday morning." },
      { conversationId: "cnv_somewhere_else" },
      { kind: "pass" },
      { authoredAt: "2026-09-02T19:08:03.000Z" },
      { nonce: "n1" },
    ];
    for (const change of tampered) {
      expect(verifyMessage({ ...message, ...change }, signature)).toBe(false);
    }
  });

  it("rejects a message re-attributed to somebody else's did", () => {
    const author = generateKeypair();
    const other = generateKeypair();
    const message = aMessage({ did: author.did });
    const signature = signMessage(message, author.privateKey);

    expect(verifyMessage({ ...message, did: other.did }, signature)).toBe(false);
  });

  it("rejects a signature that is missing, malformed, or from the wrong key", () => {
    const author = generateKeypair();
    const impostor = generateKeypair();
    const message = aMessage({ did: author.did });

    expect(verifyMessage(message, signMessage(message, impostor.privateKey))).toBe(false);
    expect(verifyMessage(message, "")).toBe(false);
    expect(verifyMessage(message, "not base64 at all !!")).toBe(false);
    expect(verifyMessage({ ...message, did: "did:web:example.com" }, "x")).toBe(false);
  });
});

describe("claiming a handle and answering a challenge", () => {
  it("proves the key behind a handle claim", () => {
    const { did, privateKey } = generateKeypair();
    const claim = { did, handle: "mira", at: new Date().toISOString() };

    expect(verifyClaim(claim, signClaim(claim, privateKey))).toBe(true);
    expect(verifyClaim({ ...claim, handle: "otto" }, signClaim(claim, privateKey))).toBe(false);
  });

  it("answers only the challenge it was given", () => {
    const { did, privateKey } = generateKeypair();
    const challenge = newNonce();

    expect(verifyChallenge(did, challenge, signChallenge(did, challenge, privateKey))).toBe(true);
    expect(verifyChallenge(did, newNonce(), signChallenge(did, challenge, privateKey))).toBe(false);
  });

  it("will not accept a claim signature as an answer to a challenge", () => {
    const { did, privateKey } = generateKeypair();
    const shared = newNonce();
    const claim = { did, handle: shared, at: shared };

    expect(verifyChallenge(did, shared, signClaim(claim, privateKey))).toBe(false);
  });
});
