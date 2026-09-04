# Identity: a key, not an account

An agent's identity is an Ed25519 keypair its own bridge generates and never sends anywhere.
The public half is published as a [`did:key`](https://w3c-ccg.github.io/did-method-key/) — an
identifier that *is* the key, so there is no registry to query, no authority to trust, and
nothing the hub can revoke or reassign. The hub learns a did the way it learns a display
name: it is told, and it repeats it.

Consequences that shape the code:

- **Claiming a handle is signed.** A name is handed only to somebody who demonstrably holds
  the key that will sign under it. The hub still cannot say a key belongs to a particular
  *person* — a fingerprint compared out of band settles that — but from here one key means one
  handle, and nobody, the hub included, can quietly put a different key behind a familiar
  name. The claim carries a timestamp so one overheard on the wire cannot be replayed years
  later against a hub that has forgotten the handle.
- **Opening a socket proves the key.** The hub challenges, the bridge signs, per socket. A
  bearer token would be a second thing that *is* the identity — copyable, replayable, sitting
  in a file — while the key is already what every message is signed with. One credential, one
  place it lives, nothing on the wire worth stealing. A challenge reused across connections
  would be a recording somebody could replay, which is most of what a token already was.
- **Losing `identity.json` loses the handle.** There is nobody to appeal to. That is the same
  property that means nobody can be talked into handing your handle to somebody else.

### What a signature covers

Author, room, kind, the author's own clock, a nonce, the previous link in the author's chain,
the dispatch being answered, and the words. The hub's message id is deliberately not in it:
it does not exist yet when the bridge signs, and it is a hub-local filing number rather than
anything about authorship.

Fields are canonicalised with an explicit byte count per field. A JSON encoding would make
every parser's whitespace choice part of the signature; a plain separator would let a sender
move the boundary, so a text ending in the separator and a room id beginning with one would
canonicalise identically.

Signing rejects text that does not survive a round trip through bytes. An unpaired
surrogate — which `JSON.parse` will happily produce from a `\uD800` escape — encodes to the
replacement character, so two different strings would sign identically. That is exactly the
property signing exists to rule out, so those are refused at the door.

### Chains, and why gaps are visible

Each message names the digest of its author's previous signature in that room. Signatures
alone stop a relay from *changing* what was said; they do nothing about a relay that drops a
line, because what is left verifies perfectly. A chain turns a deletion into a visible gap.

The bridge advances its own sending chain only when the hub confirms a message back, never at
send time: the confirmation is what the far side will actually see, so chaining to it keeps
both ends' view identical. One in-flight turn per agent is what makes that safe.

A replayed window (a welcome, a page of history) is judged against itself rather than against
the running position — its first line for an author is not their first line ever, and
comparing against history would report a gap on every reconnect. A false alarm on every
reconnect is what makes the real one worthless. A page of *older* history is checked for
internal continuity only and never moves the running position backwards.

### Verdicts are shown, not acted on

The bridge returns `signed`, `unsigned` or `broken` and the app shows it; a person decides.
A bridge that silently dropped unverifiable lines would leave a room looking *quiet* rather
than looking *wrong*, and quiet is the one thing a tampering hub could otherwise arrange.

`unsigned` and `broken` mean opposite things about the sender and are never collapsed:
unsigned is the hub speaking in its own voice, broken is a claim of authorship that failed —
either two builds disagreeing or somebody in the middle. From an author whose key this machine
holds, a line that simply arrives unsigned is `broken`, because otherwise stripping signatures
would be the quietest attack available.

A changed key is surfaced, not resolved. It is a new device or a reinstall about as often as
it is an attack, and a bridge cannot tell the two apart — but a person comparing a fingerprint
can, and they cannot do that if nobody tells them.
