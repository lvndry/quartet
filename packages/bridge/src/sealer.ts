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

import { open, packEnvelope, seal, unpackEnvelope, verifySealingKey } from "@quartet/identity";
import type { Member, Message, Opened } from "@quartet/protocol";
import { everyKey, type SealingKeys } from "./sealing-keys";

/**
 * Why there is nothing to read.
 *
 * Three states rather than `undefined`, because a person needs different words for each and
 * the app cannot tell them apart from a missing value. Defined with the snapshot rather than
 * here: what a bridge could read is something the app has to render, so it is part of the
 * contract between them rather than a detail of this file.
 */
export type { Opened };

/**
 * Who a line may be sealed to, or why it may not be sent at all.
 *
 * Refusal is a state rather than a shorter list, because the failure this exists to prevent
 * is silent: sealing to four members of a room of five produces a line the fifth sees as
 * ordinary — "written before I joined" — and nobody is told the room has quietly split. A
 * message that cannot reach everybody is not sent, and the person is told which member and
 * why.
 */
export type Recipients =
  | { readonly state: "ready"; readonly sealingDids: readonly string[] }
  | { readonly state: "refused"; readonly why: string };

/**
 * Resolve a room's roster into the keys to seal to.
 *
 * A member arrives carrying a signing key and a sealing key signed by it. Checking the second
 * against the first proves only that whoever built the pair holds both — which a hub
 * substituting both of them does. So the signing key itself has to be one this machine has
 * seen before, which is what `known.ts` records and what `isKnown` asks.
 *
 * Names play no part. Two members may share a handle, and a roster resolved by name would
 * seal to whichever of them the lookup happened to find — silently, to the wrong person.
 *
 * The caller is left out: `Sealer.toRoom` adds the sender, and adding them here as well
 * would put the decision in two places.
 */
export function recipientsFor(
  members: readonly Member[],
  meDid: string,
  isKnown: (did: string) => boolean,
): Recipients {
  const sealingDids: string[] = [];
  for (const member of members) {
    if (member.did === meDid) continue;

    if (member.sealing === undefined) {
      return {
        state: "refused",
        why: `@${member.handle} has not published a key to seal to, so this room cannot be written to privately yet. It appears once their bridge connects.`,
      };
    }

    if (!isKnown(member.did)) {
      return {
        state: "refused",
        why: `this machine has never seen the key @${member.handle} is signing with, so nothing about their sealing key can be checked. Compare fingerprints before saying anything in this room.`,
      };
    }

    const binding = {
      did: member.did,
      sealingDid: member.sealing.sealingDid,
      at: member.sealing.at,
    };
    if (!verifySealingKey(binding, member.sealing.proof)) {
      return {
        state: "refused",
        why: `the sealing key offered for @${member.handle} is not signed by the key pinned here for them. Compare fingerprints before saying anything else in this room.`,
      };
    }

    sealingDids.push(member.sealing.sealingDid);
  }
  return { state: "ready", sealingDids };
}

/**
 * One line as an agent should read it: its words, or a sentence saying it missed one.
 *
 * Never the ciphertext, and never silence. An agent handed an envelope reads the JSON as the
 * other party's words; an agent handed nothing answers a conversation with a hole in it as
 * though the hole were not there. Both are worse than being told plainly that a line is
 * there and cannot be read.
 *
 * Deliberately not what the *app* shows. A person gets styling, a link to the fingerprints,
 * and the option to go and check; an agent gets one sentence in its context window. Sharing
 * the wording would mean writing it for neither.
 */
export function withWords(message: Message, opened: Opened): Message {
  if (opened.state === "opened") return { ...message, text: opened.text };
  return {
    ...message,
    text:
      opened.state === "sealed-to-others"
        ? "(a line you have no key for — it was written before you joined this room)"
        : "(a line that would not open — say so rather than guessing what it held)",
  };
}

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
