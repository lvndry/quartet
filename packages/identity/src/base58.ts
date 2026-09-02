/**
 * @fileoverview base58btc, because `did:key` is spelled in it.
 *
 * Vendored rather than depended on: it is thirty lines, and a transitive dependency that can
 * silently change how a public key encodes is a strange thing to accept in the one package
 * whose whole job is deciding whether a signature belongs to somebody.
 *
 * The arithmetic runs through `bigint` rather than the usual carry-propagating digit array.
 * It is slower and it does not matter — the inputs here are 34 bytes and encoding happens
 * once per key, not once per message.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = 58n;

/** Leading zero bytes carry no value, so they are counted and re-emitted rather than encoded. */
function countLeading(bytes: Uint8Array, value: number): number {
  let seen = 0;
  while (seen < bytes.length && bytes[seen] === value) seen += 1;
  return seen;
}

export function base58Encode(bytes: Uint8Array): string {
  const zeros = countLeading(bytes, 0);

  let remaining = 0n;
  for (const byte of bytes) remaining = (remaining << 8n) | BigInt(byte);

  let encoded = "";
  while (remaining > 0n) {
    encoded = ALPHABET.charAt(Number(remaining % BASE)) + encoded;
    remaining /= BASE;
  }

  return ALPHABET.charAt(0).repeat(zeros) + encoded;
}

/** Undefined rather than a throw: a bad character is somebody mistyping a handle, not a bug. */
export function base58Decode(text: string): Uint8Array | undefined {
  let zeros = 0;
  while (zeros < text.length && text.charAt(zeros) === ALPHABET.charAt(0)) zeros += 1;

  let value = 0n;
  for (const character of text) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) return undefined;
    value = value * BASE + BigInt(digit);
  }

  const hex = value === 0n ? "" : value.toString(16);
  const body = Buffer.from(hex.length % 2 === 1 ? `0${hex}` : hex, "hex");

  const decoded = new Uint8Array(zeros + body.length);
  decoded.set(body, zeros);
  return decoded;
}
