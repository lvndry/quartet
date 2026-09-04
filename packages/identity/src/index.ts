/**
 * @fileoverview Who an agent is, provably, without asking anybody.
 *
 * An agent's identity is an Ed25519 keypair its own bridge generates and never sends
 * anywhere. The public half is published as a `did:key` — a W3C identifier that *is* the
 * key, so there is no registry to query, no certificate authority to trust, and nothing the
 * hub can revoke or reassign. The hub learns a did the way it learns a display name: it is
 * told, and it repeats it.
 *
 * That is the whole point. The hub relays messages it cannot forge and cannot alter, so
 * "whose hub is this" stops being a question the security of a conversation depends on.
 *
 * Deliberately free of I/O and of any quartet type. It signs bytes and checks bytes; where
 * the key is stored is the bridge's problem and what a message *is* belongs to the protocol.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, createHash } from "node:crypto";
import { base58Decode, base58Encode } from "./base58";

export { base58Decode, base58Encode };
export {
  generateSealingKeypair,
  isSealingDid,
  open,
  packEnvelope,
  publicKeyFromSealingDid,
  seal,
  sealingDidFromPublicKey,
  unpackEnvelope,
  type Envelope,
  type SealingKeypair,
} from "./sealing";

/**
 * The multicodec prefix for an Ed25519 public key, and the DER wrapper for the same 32 bytes.
 *
 * Two spellings of one key: the first is what `did:key` is defined in terms of, the second is
 * the only shape `node:crypto` will accept. Neither is negotiable, so both are constants
 * rather than something built at each call site.
 */
const ED25519_MULTICODEC = Uint8Array.from([0xed, 0x01]);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const DID_KEY_PREFIX = "did:key:z";
const RAW_PUBLIC_KEY_BYTES = 32;

/**
 * How many bytes of the key's digest a person is asked to compare out of band.
 *
 * Eight, so sixty-four bits. An attacker who wants to be mistaken for somebody has to grind
 * a preimage of that digest, and sixty-four bits puts that out of reach of anyone who is not
 * spending real money — while still being short enough to read down a phone line, which is
 * the failure mode that actually matters. A fingerprint nobody compares protects nobody.
 */
const FINGERPRINT_BYTES = 8;

/**
 * What one agent's bridge holds on disk.
 *
 * The public key is not a field because the did already is one — that is the property that
 * makes `did:key` worth using, and storing a second copy only creates a way for the two to
 * disagree.
 */
export interface Keypair {
  readonly did: string;
  /** PKCS#8, base64. Never leaves the machine, and never enters `config.json`. */
  readonly privateKey: string;
}

export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-RAW_PUBLIC_KEY_BYTES);
  return {
    did: didFromPublicKey(raw),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

export function didFromPublicKey(raw: Uint8Array): string {
  const prefixed = new Uint8Array(ED25519_MULTICODEC.length + raw.length);
  prefixed.set(ED25519_MULTICODEC);
  prefixed.set(raw, ED25519_MULTICODEC.length);
  return DID_KEY_PREFIX + base58Encode(prefixed);
}

/**
 * The 32 raw bytes inside a `did:key`, or undefined if this is not one.
 *
 * Undefined covers every way a string can fail to be an Ed25519 did — wrong scheme, bad
 * base58, some other multicodec, right codec but the wrong length. None of them are
 * distinguishable to a caller who only wants to know whether a signature can be checked,
 * and a `did:key` naming an RSA key is not a case quartet has an answer for.
 */
export function publicKeyFromDid(did: string): Uint8Array | undefined {
  if (!did.startsWith(DID_KEY_PREFIX)) return undefined;

  const decoded = base58Decode(did.slice(DID_KEY_PREFIX.length));
  if (decoded === undefined) return undefined;
  if (decoded.length !== ED25519_MULTICODEC.length + RAW_PUBLIC_KEY_BYTES) return undefined;

  const [first, second] = [decoded[0], decoded[1]];
  if (first !== ED25519_MULTICODEC[0] || second !== ED25519_MULTICODEC[1]) return undefined;

  return decoded.subarray(ED25519_MULTICODEC.length);
}

export function isDid(value: string): boolean {
  return publicKeyFromDid(value) !== undefined;
}

/**
 * The short form two people read to each other to check they mean the same agent.
 *
 * A digest of the key rather than a slice of the did, so that every bit of the fingerprint
 * depends on every bit of the key — truncating the base58 would let an attacker match a
 * prefix by grinding, which is exactly the work this is supposed to make expensive.
 */
export function fingerprint(did: string): string | undefined {
  const raw = publicKeyFromDid(did);
  if (raw === undefined) return undefined;

  const digest = createHash("sha256").update(raw).digest().subarray(0, FINGERPRINT_BYTES);
  return (digest.toString("hex").match(/.{4}/g) ?? []).join("-");
}

/** Names an agent the way it is written down and passed between people: `@mira#4f2a-…`. */
export function tag(handle: string, did: string): string | undefined {
  const short = fingerprint(did);
  return short === undefined ? undefined : `@${handle}#${short}`;
}

/**
 * Read back what somebody was given over a channel that is not this one.
 *
 * The fingerprint is optional because leaving it out is a real choice with a real cost, not a
 * mistake to reject: `@mira` alone means trusting whichever key the hub offers. Accepting
 * both shapes and letting the caller see which it got keeps that decision where it belongs,
 * with the person typing.
 */
export function parseTag(text: string): { handle: string; fingerprint?: string } | undefined {
  const match = /^@?([a-z0-9][a-z0-9_-]*)(?:#([0-9a-f]{4}(?:-[0-9a-f]{4}){3}))?$/.exec(text.trim());
  if (match === null) return undefined;

  const [, handle, short] = match;
  if (handle === undefined) return undefined;
  return short === undefined ? { handle } : { handle, fingerprint: short };
}

/* ------------------------------------------------------------------ */
/* signing                                                             */
/* ------------------------------------------------------------------ */

/**
 * What a signature is *about*.
 *
 * Every signature quartet produces names its domain first, so a signature made in one
 * context cannot be lifted into another. Without this, the string a bridge signs to prove it
 * holds a key at connection time could be replayed as though it were something the agent
 * said out loud — the bytes would verify, because they are the same bytes.
 */
export const DOMAIN = {
  message: "quartet-msg-v1",
  claim: "quartet-claim-v1",
  hello: "quartet-hello-v1",
  sealing: "quartet-sealing-v1",
} as const;

/**
 * The exact bytes covered by a signature.
 *
 * Length-prefixed fields rather than `JSON.stringify`, for two reasons that both end the same
 * way. Key order in JSON is an implementation detail, and a verifier that reproduces it
 * differently rejects honest messages; and a plain separator between fields lets a sender
 * move the boundary — a text ending in the separator and a conversation id beginning with one
 * canonicalise identically. An explicit byte count admits neither.
 */
export function canonical(domain: string, fields: readonly string[]): Buffer {
  const body = fields.map((field) => `${Buffer.byteLength(field, "utf-8")}:${field}`).join("\n");
  return Buffer.from(`${domain}\n${body}`, "utf-8");
}

function signCanonical(payload: Buffer, privateKey: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, payload, key).toString("base64");
}

/**
 * Whether these exact bytes were signed by the holder of this did.
 *
 * False, never a throw. Everything reaching this function came off a socket, so a malformed
 * did or a signature that is not base64 is an ordinary rejection and not an exceptional
 * condition — and a verifier that throws is a verifier somebody eventually wraps in a
 * try/catch that swallows the answer.
 */
function verifyCanonical(payload: Buffer, signature: string, did: string): boolean {
  const raw = publicKeyFromDid(did);
  if (raw === undefined) return false;

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
      format: "der",
      type: "spki",
    });
    return verify(null, payload, key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/**
 * One line an agent said, as its author signed it.
 *
 * The hub's own message id is deliberately not in here: it does not exist yet when the bridge
 * signs, and it is a hub-local filing number rather than anything about authorship. What has
 * to be covered is everything a hub could otherwise change without detection — who spoke,
 * where, when, whether it was speech or silence, and the words.
 */
export interface SignedMessage {
  readonly did: string;
  readonly conversationId: string;
  readonly kind: string;
  /** The author's clock, not the hub's. The hub's `at` is a receipt; this is a claim. */
  readonly authoredAt: string;
  /** Makes two identical lines in one conversation distinct, so neither can replay the other. */
  readonly nonce: string;
  /**
   * The digest of this author's previous signed line, chaining their own messages together.
   *
   * Empty on the first. Signatures alone stop a relay from *changing* what was said; they do
   * nothing about a relay that drops a line, because what is left still verifies perfectly.
   * A chain is what turns a deletion into a visible gap, and it is in the signed payload from
   * the start so that turning the check on later is a change to a verifier, not to a format.
   */
  readonly prev: string;
  readonly text: string;
}

function messagePayload(message: SignedMessage): Buffer {
  return canonical(DOMAIN.message, [
    message.did,
    message.conversationId,
    message.kind,
    message.authoredAt,
    message.nonce,
    message.prev,
    message.text,
  ]);
}

export function signMessage(message: SignedMessage, privateKey: string): string {
  return signCanonical(messagePayload(message), privateKey);
}

export function verifyMessage(message: SignedMessage, signature: string): boolean {
  return verifyCanonical(messagePayload(message), signature, message.did);
}

/**
 * The digest a following message names as its `prev`.
 *
 * Taken over the signature rather than the text: a signature already commits to every field
 * of the message including its own `prev`, so hashing it chains the whole history in one
 * step, and it cannot be reproduced by anybody who did not hold the key.
 */
export function linkAfter(signature: string): string {
  return createHash("sha256").update(signature, "utf-8").digest("hex");
}

/**
 * A handle claim: this key is asking to be known as this name, at this moment.
 *
 * The timestamp is signed so a claim overheard once cannot be replayed years later against a
 * hub that has since forgotten the handle.
 */
export interface HandleClaim {
  readonly did: string;
  readonly handle: string;
  readonly at: string;
}

function claimPayload(claim: HandleClaim): Buffer {
  return canonical(DOMAIN.claim, [claim.did, claim.handle, claim.at]);
}

export function signClaim(claim: HandleClaim, privateKey: string): string {
  return signCanonical(claimPayload(claim), privateKey);
}

export function verifyClaim(claim: HandleClaim, signature: string): boolean {
  return verifyCanonical(claimPayload(claim), signature, claim.did);
}

/** Answering the hub's opening challenge — proof of the key, in place of a bearer token. */
function helloPayload(did: string, challenge: string): Buffer {
  return canonical(DOMAIN.hello, [did, challenge]);
}

export function signChallenge(did: string, challenge: string, privateKey: string): string {
  return signCanonical(helloPayload(did, challenge), privateKey);
}

export function verifyChallenge(did: string, challenge: string, signature: string): boolean {
  return verifyCanonical(helloPayload(did, challenge), signature, did);
}

/**
 * An agent saying which sealing key its words may be sealed to.
 *
 * The identity key is the only thing anybody has pinned, so it is the only thing that can
 * introduce a second key. Without this binding the hub would be free to answer "what is
 * @mira's sealing key" with one of its own and read the room — the signatures on the messages
 * would still verify, because sealing and signing would be answering to different authorities.
 *
 * `at` is signed so a rotation cannot be undone by replay. A key rotated *because* it leaked
 * is exactly the case where a hub would like to keep offering the old binding, and a verifier
 * that has seen a newer one can refuse this on the timestamp alone.
 */
export interface SealingBinding {
  readonly did: string;
  readonly sealingDid: string;
  readonly at: string;
}

function sealingPayload(binding: SealingBinding): Buffer {
  return canonical(DOMAIN.sealing, [binding.did, binding.sealingDid, binding.at]);
}

export function signSealingKey(binding: SealingBinding, privateKey: string): string {
  return signCanonical(sealingPayload(binding), privateKey);
}

export function verifySealingKey(binding: SealingBinding, signature: string): boolean {
  return verifyCanonical(sealingPayload(binding), signature, binding.did);
}

/** One use, once. Good enough for both a message nonce and a hub's connection challenge. */
export function newNonce(): string {
  return randomUUID().replaceAll("-", "");
}
