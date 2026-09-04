/**
 * @fileoverview Sealing a line so only the room can read it.
 *
 * The identity keypair in `index.ts` answers "who said this". This answers "who may read
 * it", and they are deliberately separate keys: signing and key agreement are different jobs
 * with different lifetimes, and an Ed25519 key repurposed for Diffie-Hellman is a footgun
 * with a long history.
 *
 * A room holds at most `MAX_ROOM_MEMBERS` agents, which is why there is no group protocol
 * here. Every message is sealed once per recipient — five wrapped keys in the worst case —
 * and that buys the absence of epochs, rekeying, and the "which member is on which
 * generation" bug class a group scheme carries in exchange for scaling to hundreds.
 *
 * What this does not do is hide who is talking to whom. The hub still routes by agent, still
 * counts turns, still bills. Sealing removes the words and nothing else, and anything that
 * tells a person otherwise is lying to them.
 *
 * Deliberately free of I/O and of any quartet type, like its neighbour: it seals bytes and
 * opens bytes. Where the key lives is the bridge's problem.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { base58Decode, base58Encode } from "./base58";

/**
 * The multicodec prefix for an X25519 public key, and the DER wrapper for the same 32 bytes.
 *
 * The same two spellings `index.ts` needs for Ed25519, for the same two reasons: `did:key` is
 * defined over the first, and `node:crypto` will only accept the second.
 */
const X25519_MULTICODEC = Uint8Array.from([0xec, 0x01]);
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const DID_KEY_PREFIX = "did:key:z";
const RAW_PUBLIC_KEY_BYTES = 32;

/** AES-GCM, 256-bit keys. Twelve-byte nonces, because that is the size GCM is defined for. */
const CONTENT_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * One agent's sealing keypair, as its bridge holds it.
 *
 * A did rather than a bare key so the wire format says which algorithm it is: a future suite
 * change becomes a did nothing can misread, rather than thirty-two ambiguous bytes an older
 * build would feed to the wrong primitive.
 */
export interface SealingKeypair {
  readonly sealingDid: string;
  /** PKCS#8, base64. Never leaves the machine. */
  readonly privateKey: string;
}

export function generateSealingKeypair(): SealingKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-RAW_PUBLIC_KEY_BYTES);
  return {
    sealingDid: sealingDidFromPublicKey(raw),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

export function sealingDidFromPublicKey(raw: Uint8Array): string {
  const prefixed = new Uint8Array(X25519_MULTICODEC.length + raw.length);
  prefixed.set(X25519_MULTICODEC);
  prefixed.set(raw, X25519_MULTICODEC.length);
  return DID_KEY_PREFIX + base58Encode(prefixed);
}

/** The thirty-two raw bytes inside an X25519 `did:key`, or undefined if it is not one. */
export function publicKeyFromSealingDid(did: string): Uint8Array | undefined {
  if (!did.startsWith(DID_KEY_PREFIX)) return undefined;

  const decoded = base58Decode(did.slice(DID_KEY_PREFIX.length));
  if (decoded === undefined) return undefined;
  if (decoded.length !== X25519_MULTICODEC.length + RAW_PUBLIC_KEY_BYTES) return undefined;

  const [first, second] = [decoded[0], decoded[1]];
  if (first !== X25519_MULTICODEC[0] || second !== X25519_MULTICODEC[1]) return undefined;

  return decoded.subarray(X25519_MULTICODEC.length);
}

export function isSealingDid(value: string): boolean {
  return publicKeyFromSealingDid(value) !== undefined;
}

/**
 * A sealed line, as it travels and as the hub stores it.
 *
 * Versioned from the first release. The alternative is discovering the format needs changing
 * and having no way to say which one a given row is written in — and rows outlive builds
 * here, because nothing expires.
 */
export interface Envelope {
  readonly v: 1;
  /** The ephemeral public key this message's shared secrets were derived against. */
  readonly epk: string;
  /** Sealing did to the content key wrapped for that member. At most one entry per member. */
  readonly recipients: Readonly<Record<string, string>>;
  readonly ct: string;
}

/**
 * An envelope as one string, for the places that carry an opaque blob rather than a shape.
 *
 * Worth having as a pair of named functions rather than `JSON.stringify` at each call site:
 * the hub stores steers in a TEXT column and relays them without looking, and keeping that
 * end of the wire a string is what makes "the hub cannot read this" a property of the code
 * rather than a promise about it. Nothing there needs to know an envelope has fields.
 */
export function packEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

/** Undefined for anything that is not an envelope — including plaintext from an older build. */
export function unpackEnvelope(packed: string): Envelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packed);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Partial<Envelope>;
  if (candidate.v !== 1) return undefined;
  if (typeof candidate.epk !== "string" || typeof candidate.ct !== "string") return undefined;
  if (typeof candidate.recipients !== "object" || candidate.recipients === null) return undefined;
  if (Object.values(candidate.recipients).some((wrap) => typeof wrap !== "string")) {
    return undefined;
  }

  return candidate as Envelope;
}

function importPublicKey(raw: Uint8Array): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

function importPrivateKey(base64: string): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({ key: Buffer.from(base64, "base64"), format: "der", type: "pkcs8" });
}

/**
 * The key one recipient's copy of the content key is wrapped under.
 *
 * The recipient's own sealing did goes in as `info`, so the wrap for @mira cannot be lifted
 * out and replayed as the wrap for @sam even by somebody holding the ephemeral key: two
 * recipients of one message derive two different wrapping keys from the same secret.
 */
function wrappingKey(shared: Buffer, context: string, recipient: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.from(context, "utf8"),
      Buffer.from(recipient, "utf8"),
      CONTENT_KEY_BYTES,
    ),
  );
}

/** `nonce | tag | ciphertext`, base64. One string rather than three fields somebody can reorder. */
function encrypt(key: Buffer, plaintext: Buffer, context: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}

/** Undefined on every failure — wrong key, wrong context, truncated input, forged tag. */
function decrypt(key: Buffer, packed: string, context: string): Buffer | undefined {
  const raw = Buffer.from(packed, "base64");
  if (raw.length < NONCE_BYTES + TAG_BYTES) return undefined;

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, NONCE_BYTES));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    return undefined;
  }
}

/**
 * Seal one line to everybody who may read it.
 *
 * `context` is bound into every derivation and every tag, and callers pass the conversation
 * id: an envelope lifted out of one room and replayed into another stops opening, whatever
 * the signature wrapped around it happens to say.
 *
 * The sender is expected to appear in `recipients`. Not enforced here, because this cannot
 * know who is calling — but a bridge that leaves itself out has written a line it can never
 * read back, and its own history is what it loses.
 */
export function seal(
  plaintext: string,
  recipients: readonly string[],
  context: string,
): Envelope | undefined {
  const unique = [...new Set(recipients)];
  if (unique.length === 0) return undefined;

  const ephemeral = generateKeyPairSync("x25519");
  const contentKey = randomBytes(CONTENT_KEY_BYTES);

  const wrapped: Record<string, string> = {};
  for (const recipient of unique) {
    const raw = publicKeyFromSealingDid(recipient);
    if (raw === undefined) return undefined;
    const shared = diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: importPublicKey(raw),
    });
    wrapped[recipient] = encrypt(wrappingKey(shared, context, recipient), contentKey, context);
  }

  const epk = ephemeral.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-RAW_PUBLIC_KEY_BYTES);

  return {
    v: 1,
    epk: Buffer.from(epk).toString("base64"),
    recipients: wrapped,
    ct: encrypt(contentKey, Buffer.from(plaintext, "utf8"), context),
  };
}

/**
 * Open a line sealed to this agent, or undefined.
 *
 * Undefined is not one condition. It is "not sealed to me", which is what a room joined after
 * the line was written looks like; "sealed to a key I no longer hold", which is a rotation or
 * a restore without the archive; and "does not open", which is damage or forgery. All three
 * are indistinguishable here and all three need different words in front of a person. The
 * caller decides which from what it knows about the room — this only reports that there is
 * nothing to read.
 */
export function open(
  envelope: Envelope,
  sealingDid: string,
  privateKey: string,
  context: string,
): string | undefined {
  if (envelope.v !== 1) return undefined;

  const wrapped = envelope.recipients[sealingDid];
  if (wrapped === undefined) return undefined;

  const epk = Buffer.from(envelope.epk, "base64");
  if (epk.length !== RAW_PUBLIC_KEY_BYTES) return undefined;

  let shared: Buffer;
  try {
    shared = diffieHellman({
      privateKey: importPrivateKey(privateKey),
      publicKey: importPublicKey(epk),
    });
  } catch {
    return undefined;
  }

  const contentKey = decrypt(wrappingKey(shared, context, sealingDid), wrapped, context);
  if (contentKey === undefined || contentKey.length !== CONTENT_KEY_BYTES) return undefined;

  return decrypt(contentKey, envelope.ct, context)?.toString("utf8");
}
