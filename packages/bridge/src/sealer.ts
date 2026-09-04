/**
 * @fileoverview Sealing what this agent writes, and opening what is sealed to it.
 *
 * `attest.ts` is the file that demotes the hub from *authority*: a hub that rewrites a line
 * produces something that no longer verifies. This is the file that demotes it from
 * *audience*. Both are the same argument made twice — the security of a conversation should
 * not depend on whose machine is in the middle — and they are separate objects because they
 * fail separately. A broken signature means somebody tampered. A line that will not open
 * usually means nothing worse than a room joined late.
 *
 * Like the attestor, this returns what it found and decides nothing. A bridge that swapped an
 * unreadable line for silence would leave a room looking quiet rather than looking partial,
 * and quiet is what a person stops asking about.
 */

import { open, packEnvelope, seal, unpackEnvelope } from "@quartet/identity";
import { everyKey, type SealingKeys } from "./sealing-keys";

/**
 * Why there is nothing to read.
 *
 * Three states rather than `undefined`, because a person needs different words for each and
 * the app cannot tell them apart from a missing value. `sealed-to-others` is ordinary — it is
 * what every line written before you joined a room looks like. `unopenable` is a key that
 * should have worked and did not, which is damage or forgery and worth saying loudly.
 */
export type Opened =
  | { readonly state: "opened"; readonly text: string }
  | { readonly state: "sealed-to-others" }
  | { readonly state: "unopenable" };

export class Sealer {
  private readonly keys: SealingKeys;

  constructor(keys: SealingKeys) {
    this.keys = keys;
  }

  /** The key other agents are told to seal this agent's copy to. */
  get sealingDid(): string {
    return this.keys.current.sealingDid;
  }

  /**
   * Seal a line to a room, this agent included.
   *
   * The sender is added rather than trusted to appear in `recipients`, because forgetting is
   * silent at write time and only shows up later as a room the author cannot read back.
   */
  toRoom(text: string, recipients: readonly string[], context: string): string | undefined {
    const envelope = seal(text, [this.sealingDid, ...recipients], context);
    return envelope === undefined ? undefined : packEnvelope(envelope);
  }

  /** Seal a line only this agent will ever read. A steer, and nothing else so far. */
  toSelf(text: string, context: string): string | undefined {
    return this.toRoom(text, [], context);
  }

  /**
   * Open a line, trying the current key and then every retired one.
   *
   * The archive is walked rather than indexed by did: the envelope names the keys it was
   * sealed to, but a rotation this bridge performed and a room it was never in look identical
   * from the outside, and there are a handful of keys rather than a table.
   */
  open(packed: string, context: string): Opened {
    const envelope = unpackEnvelope(packed);
    if (envelope === undefined) return { state: "unopenable" };

    const mine = everyKey(this.keys).filter(
      (key) => envelope.recipients[key.sealingDid] !== undefined,
    );
    if (mine.length === 0) return { state: "sealed-to-others" };

    for (const key of mine) {
      const text = open(envelope, key.sealingDid, key.privateKey, context);
      if (text !== undefined) return { state: "opened", text };
    }
    // Sealed to a key this agent holds, and it still did not open: the ciphertext is damaged
    // or somebody rewrote it. Never quiet.
    return { state: "unopenable" };
  }
}
