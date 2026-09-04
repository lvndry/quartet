/**
 * @fileoverview Signing what this agent says, and checking what arrives.
 *
 * The file that demotes the hub: a hub that rewrites a message, invents one, or swaps a key
 * behind a familiar name produces something that does not verify here.
 *
 * It deliberately does not decide what to do about a failure — it returns a verdict and the
 * app shows it. `docs/design.md` §2 says why.
 */

import {
  linkAfter,
  newNonce,
  signChallenge,
  signMessage,
  verifyMessage,
  type Keypair,
} from "@quartet/identity";
import type { Authorship, Message, MessageKind, Verdict } from "@quartet/protocol";
import { Journal } from "./journal";

/** One author's thread within one conversation. A handle cannot contain a space. */
function chainKey(message: Message): string {
  return `${message.conversationId} ${message.authorHandle}`;
}

// The app shows every verdict, so its shape is part of the bridge↔app contract rather than
// this module's own business. Re-exported because callers here think of it as ours.
export type { Verdict };

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
   * The sending side advances only when the hub confirms a message back, which is what the
   * other side will actually see. One in-flight turn per conversation makes that safe.
   */
  private readonly journal: Journal;

  /**
   * Where each author had reached *within the window currently being replayed*.
   *
   * A welcome's first line for an author is not their first line ever, so comparing against
   * the running position would report a gap on every reconnect.
   */
  private readonly windowChain = new Map<string, string>();

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

  /** A replayed transcript is about to arrive; judge it against itself, not against history. */
  startWindow(): void {
    this.windowChain.clear();
  }

  /**
   * Take the replayed window as the new running position.
   *
   * After a welcome, whose window ends at the newest line, and deliberately not after a page
   * of older history: that would rewind the chain and make the next live line look like it
   * had something missing before it.
   */
  settleWindow(): void {
    for (const [key, link] of this.windowChain) this.journal.recordSeen(key, link);
  }

  /** Answer the hub's opening challenge — this agent's whole side of signing in. */
  answer(challenge: string): string {
    return signChallenge(this.keypair.did, challenge, this.keypair.privateKey);
  }

  /**
   * Authorship for something this agent is about to say in answer to a dispatched turn.
   *
   * `dispatch` is signed rather than merely sent, so authorship covers *which turn* produced
   * the line and a relay cannot file an answer against a different one.
   */
  speak(conversationId: string, kind: MessageKind, dispatch: string, text: string): Authorship {
    const authoredAt = new Date().toISOString();
    const nonce = newNonce();
    const prev = this.journal.lastOwn(conversationId);
    return {
      authoredAt,
      nonce,
      prev,
      signature: signMessage(
        { did: this.keypair.did, conversationId, kind, authoredAt, nonce, prev, dispatch, text },
        this.keypair.privateKey,
      ),
    };
  }

  /**
   * Judge one message, and advance whichever chain it belongs to.
   *
   * Including this agent's own coming back confirmed: trusting those would be trusting the
   * hub to have relayed them unchanged, which is the assumption being removed.
   */
  check(message: Message, context: Context, options: { replay?: boolean } = {}): Verdict {
    const signature = message.signature;
    if (signature === undefined) {
      // Unremarkable only when the hub is speaking in its own voice. From an author this
      // machine holds a key for, stripping the signature would otherwise be the quietest
      // attack available.
      if (message.kind === "system") return UNSIGNED;
      if (context.expectedDid === undefined) return UNSIGNED;
      return broken("this author signs everything, and this line arrived unsigned");
    }

    // A key nobody has pinned proves nothing: a stranger signs perfectly well as themselves
    // while wearing any handle they like.
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
        dispatch: signature.dispatch,
        text: message.text,
      },
      signature.value,
    );

    if (!verified) return broken("the signature does not match what was said");

    const key = chainKey(message);
    const link = linkAfter(signature.value);
    // Advance whatever the verdict: a gap is reported once, at the line where it shows.
    const replay = options.replay === true;
    const expected = replay ? this.windowChain.get(key) : this.journal.lastSeen(key);
    if (replay) this.windowChain.set(key, link);
    else this.journal.recordSeen(key, link);

    if (expected !== undefined && signature.prev !== expected) {
      // Genuine, just not the next one. Something between here and its author is missing,
      // which a signature alone could never have shown.
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
