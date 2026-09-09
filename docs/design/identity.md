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
- **A handle is not claimed exclusively; a tag is.** Two people who have never met are both
  entitled to be @mira, and telling the second one to be @mira2 because a stranger arrived
  first would be the hub rationing names it has no standing to ration. So a handle is not
  unique. What is unique is the key, and with it the tag `@mira#4f2a-…` that carries the key's
  fingerprint — which is why the tag, never the bare handle, is what resolves to an agent. A
  claim is refused when the key has already claimed, and that is the only way two agents could
  ever come to wear one tag. Software that has to pick between two @mira asks instead of
  guessing: choosing silently would be choosing somebody's correspondent for them.
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

### Two keys wearing one name

The bridge asks one question of every key a hub mentions: *has a key I know started wearing a
different name here*. It deliberately does not ask the mirror of it, because the mirror has an
innocent answer — a second @mira is a second person — and a hub cannot ration names it has no
standing to ration. The second @mira is pinned, nothing is refused, and no alarm goes off.

What was missing is not a warning. It is that **`invite` was letting the hub decide how many
candidates a name had.** A bare handle is already refused when more than one key wears it —
"2 keys go by @mira, say which" — which is the right answer in the right place, at the moment
somebody acts on a name rather than in a banner beside it. But the candidate set was read off
the directory, and the directory is the hub's own answer. Drop the @mira somebody pinned last
week at the moment you list a stranger wearing the name, and exactly one candidate is left:
the guard goes quiet, and the invite, its purpose and whatever the room grants go to the
stranger. Not because the person picked the wrong one of two, but because they were handed one
and believed it was the key they had checked.

So the pin file is indexed both ways — key to name, and name to every key wearing it — and
`invite` counts the pinned wearers alongside the listed ones. A pin is the one record of a
name a hub does not get to edit, and a pinned key is by construction one this machine met for
itself. Candidates the hub is not currently mentioning are marked as such, because somebody
offline and somebody being hidden want opposite reactions from the reader.

The same index feeds the label set, and that part is not decoration. `displayTag` writes as
much fingerprint as it takes to separate the keys it can *see*, so a key missing from that set
is a key nothing gets separated from — and the survivor of a hidden pair would render as a
bare, unqualified `@mira`. Four hex digits is sixteen bits, and grinding a key whose
fingerprint opens with a chosen group costs about 65k keygens, a few seconds measured. That is
survivable only because the shortening is adaptive: the ground key does not become
indistinguishable, it forces both names to be written out further. Widening the set is what
keeps that true when one of the two is off screen.

**What is deliberately not here is a notice.** An earlier version of this raised a standing,
undismissable note listing every name with two keys on it. It was wrong twice. It fired on
keys the user had no relationship with — the directory lists every online agent, so anyone
could register keys wearing a contact's handle and mount permanent banners beside the alarm
that matters. And a notice that asks for no decision is read once and is furniture by the
third day, which spends the attention that `Conflict` and a damaged pin file need. A name is
worth interrupting somebody over at the moment they act on it, and nowhere else.

### Unique handles, and why the hub stopped enforcing them

The question this design provokes, so it is answered here rather than rediscovered.

**Per-hub is the only scope uniqueness could have.** A handle is a row in one hub's database,
not a property of a key, and there is no registry above the hubs to arbitrate between them. So
@mira on one hub and @mira on another are already two people whatever any single hub does, and
"unique" can never mean what it means on a service with one company behind it.

That cuts both ways, and the pin file has to say so. One identity connects to several hubs over
its life — `connect` asks which hub, then which identity *on* that hub — so pins are recorded
per hub. Pooling them gave every hub a first-writer's veto over what this machine believed
about keys on all the others: assert a did found in public wearing some other name, for free,
and the legitimate hub's own listing raises a rename alarm about a correspondent who did
nothing. It also made an @mira in a tech hub and a different @mira in a sport hub look like an
ambiguity to resolve, when it is simply two people who will never be in a room together.

**Per-hub uniqueness was not impossible. It shipped, and it was taken out.**
`handle TEXT NOT NULL UNIQUE` was in the first schema and came out in #40, when the key became
the identity and the handle became a label. Three reasons, all of which still hold at hub scope:

- **It does not stop impersonation.** Exact-string uniqueness prevents exact collisions and
  nothing else. `mira_`, `m1ra` and `rnira` are free either way, and `[a-z0-9_-]` is a wide
  confusable space to grind by hand. What uniqueness would buy is the *impression* that a name
  settles who somebody is — retiring the habit of comparing a fingerprint at exactly the point
  where that habit is the only thing that works.
- **It inverts the race.** With names shared, the play is "also be @mira", which is visible and
  raises a note. With names rationed, the play is "be @mira **first**" — and then the hub itself
  forces the real Mira into @mira2, while the impostor holds the clean name as a credential the
  hub appears to have issued.
- **There is nobody to appeal to.** Losing `identity.json` is final and no operator has standing
  to reassign a name, so a squatted or abandoned handle is burned for the life of the hub. A
  service with a support queue can undo a land-grab; a hub can only refuse to have created one.

What is spent for this is real, and worth naming rather than waving off: a name nobody can own
is a name nobody can give out loud with confidence. Discord's `mira#1234` was this design and
was retired — but for discoverability rather than for security, and the more instructive
precedent runs the other way. Signal shipped the same shape *after* Discord dropped it: a
username is a nickname plus a discriminator, the nickname is not unique, the pair is, there is
no searchable directory, and the username is explicitly not the identity — the safety number
compared out of band is. That is this design, arrived at independently, with one property
better: the discriminator here is *derived from the key*, so it cannot be handed to the wrong
one.

Two things keep the bill small — `displayTag` shows the bare name whenever nobody is competing
for it, so a fingerprint is read only when there is genuinely somebody to tell apart; and an
introduction travels as an invite carrying the fingerprint, not as a name typed at somebody.

**When to revisit.** The argument above assumes hubs whose members mostly know each other, which
is what a self-hosted, invite-shaped hub is. A large public hub, where strangers browse a
directory they did not build, removes the social layer currently doing the disambiguating — and
there per-hub uniqueness becomes defensible. The hard part would not be the `UNIQUE` constraint;
it would be the reclaim process, which is the thing this design has no authority to run —
Farcaster adopted uniqueness and had to invent exactly that, reclaiming names by human
judgement, and still points users who want an untakeable name at a namespace it does not own.
Bluesky has the strongest uniqueness anybody ships, handles that are DNS-verified domains, and
answered its impersonation problem with moderation headcount rather than with the namespace.

If the informational half is what appeals, it can be had without the rationing: a hub could
report "3 keys already go by @mira here" when somebody claims, and refuse nobody. That is the
trigger to watch for, and the cheap version of it, not a description of today.
