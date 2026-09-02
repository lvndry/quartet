/**
 * @fileoverview Signing what this agent says, and checking what arrives.
 *
 * This is the file that demotes the hub. Outbound, every line is signed with the key from
 * `identity.ts` before it leaves; inbound, every line is checked against the did the other
 * party's handle is bound to. A hub that rewrites a message, invents one, or swaps a key
 * behind a familiar name produces something that does not verify here.
 *
 * What it deliberately does *not* do is decide what to do about a failure. It returns a
 * verdict; the app shows it and a person decides. A bridge that silently dropped
 * unverifiable lines would leave a room looking quiet rather than looking wrong, and quiet is
 * the one thing a tampering hub could otherwise arrange.
 */

import {
  linkAfter,
  newNonce,
  signChallenge,
  signMessage,
  verifyMessage,
  type Keypair,
} from "@quartet/identity";
import type { Authorship, Message, MessageKind } from "@quartet/protocol";
import { Journal } from "./journal";

/** One author's thread within one conversation. A handle cannot contain a space. */
function chainKey(message: Message): string {
  return `${message.conversationId} ${message.authorHandle}`;
}

/**
 * What checking one message concluded.
 *
 * `unsigned` and `broken` are kept apart because they mean opposite things about the sender.
 * Unsigned is the hub speaking in its own voice, or an agent old enough to predate keys —
 * unremarkable. Broken is a claim of authorship that failed, which is either two builds
 * disagreeing or somebody in the middle, and neither should ever be shown as merely missing.
 */
export type Verdict =
  | { readonly state: "signed" }
  | { readonly state: "unsigned" }
  | { readonly state: "broken"; readonly why: string };

const SIGNED: Verdict = { state: "signed" };
const UNSIGNED: Verdict = { state: "unsigned" };

function broken(why: string): Verdict {
  return { state: "broken", why };
}

/** What the bridge has to know about a room to judge a line in it. */
export interface Context {
  /** The did the author's handle is bound to, as this bridge last saw it. */
  readonly expectedDid: string | undefined;
}

export class Attestor {
  private readonly keypair: Keypair;

  /**
   * Where the chains have got to, on disk.
   *
   * The sending side is advanced only when the hub confirms a message back, never at send
   * time: the hub's confirmation is what the other side will actually see, so chaining to it
   * keeps both ends' view of the sequence identical. One in-flight turn per conversation is
   * what makes that safe — there is never a second message signed before the first lands.
   */
  private readonly journal: Journal;

  constructor(keypair: Keypair, journal: Journal = new Journal()) {
    this.keypair = keypair;
    this.journal = journal;
  }

  /** Read the chain back off disk. Must happen before anything is signed or judged. */
  async ready(): Promise<void> {
    await this.journal.load();
  }

  get did(): string {
    return this.keypair.did;
  }

  /** Answer the hub's opening challenge — this agent's whole side of signing in. */
  answer(challenge: string): string {
    return signChallenge(this.keypair.did, challenge, this.keypair.privateKey);
  }

  /** Authorship for something this agent is about to say in a room that already exists. */
  speak(conversationId: string, kind: MessageKind, text: string): Authorship {
    const authoredAt = new Date().toISOString();
    const nonce = newNonce();
    const prev = this.journal.lastOwn(conversationId);
    return {
      authoredAt,
      nonce,
      prev,
      signature: signMessage(
        { did: this.keypair.did, conversationId, kind, authoredAt, nonce, prev, text },
        this.keypair.privateKey,
      ),
    };
  }

  /**
   * Judge one message, and advance whichever chain it belongs to.
   *
   * Called for every message that arrives, including this agent's own coming back confirmed —
   * a bridge that trusted its own messages on the way home would be trusting the hub to have
   * relayed them unchanged, which is the assumption being removed.
   */
  check(message: Message, context: Context): Verdict {
    const signature = message.signature;
    if (signature === undefined) {
      // Missing is only unremarkable when the hub is speaking in its own voice. From an
      // author this machine holds a key for, a line that simply arrives without a signature
      // is the whole layer being switched off — and reporting that as the same soft state a
      // legacy agent gets would make stripping signatures the quietest attack available.
      if (message.kind === "system") return UNSIGNED;
      if (context.expectedDid === undefined) return UNSIGNED;
      return broken("this author signs everything, and this line arrived unsigned");
    }

    // A key nobody has pinned proves nothing: an unknown correspondent can sign perfectly
    // well as themselves while wearing any handle they like.
    if (context.expectedDid === undefined) {
      return broken("nobody has told this bridge which key that handle signs with");
    }
    if (signature.did !== context.expectedDid) {
      return broken("signed with a different key than that handle is known by");
    }

    const verified = verifyMessage(
      {
        did: signature.did,
        conversationId: message.conversationId,
        kind: message.kind,
        authoredAt: signature.authoredAt,
        nonce: signature.nonce,
        prev: signature.prev,
        text: message.text,
      },
      signature.value,
    );

    if (!verified) return broken("the signature does not match what was said");

    const key = chainKey(message);
    const expected = this.journal.lastSeen(key);
    // Advance whatever the verdict. A gap is worth reporting once, at the line where it shows;
    // carrying it forward would mark every later line broken for one missing early one.
    this.journal.recordSeen(key, linkAfter(signature.value));
    if (expected !== undefined && signature.prev !== expected) {
      // The line itself is genuine — it just is not the next one. Something between here and
      // its author is missing, which a signature alone could never have shown.
      return broken("a line from this author is missing before this one");
    }
    return SIGNED;
  }

  /** Remember where this agent's own chain has reached, from a message the hub confirmed. */
  confirmOwn(message: Message): void {
    if (message.signature === undefined) return;
    this.journal.recordOwn(message.conversationId, linkAfter(message.signature.value));
  }
}
