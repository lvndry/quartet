# Confidentiality, disclosure, and long-session memory

Three changes. The first is **built**; the second and third are agreed and not built. The
first two are one project — a hub that cannot read a room, and a room that says so.

---

## Why

The hub used to store every line of every room in plaintext, forever. That is a defensible
design for a socket router nobody deployed, and fine as long as nothing implies otherwise.
Self-hosting implies otherwise. "Run your own hub" reads as "nobody else sees this", and in a
two-party room hosted by one of the two it is worse than a neutral third party would be: the
counterparty's plaintext sat in your SQLite, and nothing in the product said so.

So: encrypt what the hub does not need, disclose exactly what is left, and never let the
disclosure claim more than the code delivers.

---

## 1. End-to-end encryption — built

### Shape

Fanout, not a group protocol. `MAX_ROOM_MEMBERS` is 6, so sealing separately to each
recipient costs at most five wrapped keys — and buys the absence of a group state machine: no
epochs, no rekey, no "which member is on which generation" bug class. MLS is right for rooms
of hundreds and is a large amount of machinery to carry for five.

A second keypair per identity: X25519, beside the Ed25519 identity in the same data
directory, on `node:crypto` (`diffieHellman`, HKDF, AES-256-GCM). No new dependency.
`identity/sealing.ts` seals bytes; `bridge/sealing-keys.ts` decides where the key lives.

    { v: 1,
      epk:        <ephemeral X25519 public key>,
      recipients: { <sealing did>: <content key wrapped for that member> },
      ct:         AES-256-GCM(content key, plaintext, aad) }

A fresh content key per message. For each member: ECDH(ephemeral, their X25519) → HKDF
(salt = conversation id, info = their sealing did) → wrap. The conversation id is bound into
every derivation and every tag, so an envelope lifted into another room stops opening whatever
signature is wrapped around it. The sender seals to itself as well, so there is one read path
rather than a special case for your own lines.

### Distribution

`hello` carries a `SealingClaim` — the X25519 public key, when it was bound, and an Ed25519
signature over both by the did answering the challenge. The hub verifies the proof and refuses
the socket if it does not hold, stores the claim on the agent row, and relays it. It cannot
mint one: it does not hold the key that signs it.

`conversation.participants` carries members rather than handles — handle, signing did, sealing
claim — because a room's roster *is* the recipient list. It has to be the roster and not the
sender's connections: `conversation.add` spends the adder's connection, so a room's third
member is somebody the second has never been introduced to.

Before sealing, a bridge checks each member's proof **against the did it has pinned for that
handle**, not against the did that arrived in the same frame. A hub substituting both would
produce an internally consistent frame; `known.ts` is what it cannot satisfy. A mismatch, a
missing pin, or a member with no published key **refuses the whole line** rather than sealing
to the members it can reach — a partial seal reads as "written before I joined" on the side
left out, which is a room silently split in two.

### Signing

Unchanged. `SignedMessage.text` is the envelope, so the signature covers the ciphertext by
construction and `@quartet/identity`, `attest.ts`, `prev` chaining, `linkAfter` and the
journal are all untouched. The hub keeps its door check: it verifies the signature and the
membership exactly as before and simply cannot read what it admits. Bridges verify *then*
decrypt, never the reverse.

For the same reason, a `Message` keeps the text its author signed. What a bridge recovered
from it travels beside the transcript, in `BridgeState.opened`, next to the verdicts — merging
them would leave a signature sitting against text it does not cover, and anything that checked
it later would report tampering.

### Membership

Adding a member means including them as a recipient on future messages. Nothing else.
**History starts at join** — a stated semantic, not an accident. A later increment can let an
existing member's bridge re-encrypt a backfill on request; that needs the bridge online at the
moment somebody is admitted, which is why it is not here. Removal is symmetric: they stop
being a recipient and keep whatever they already read. No scheme prevents that.

### Plaintext on purpose

- **Hub-authored system messages.** The hub's own voice, rendered as `unsigned` rather than as
  somebody's words.
- **Handles, display names, bios.** A directory is public by construction.
- **Purposes.** Sealing these pairwise at invite time is the remaining piece of this section.
  The cost is that `/join` and the hub can no longer show what somebody is being invited to.

### Flag day

Pre-release, so no migration: **wipe the hub database**. That is also what kills the mixed
plaintext/ciphertext room and the "some members cannot decrypt" state machine before either
exists. A pre-encryption line reads as `unopenable`, deliberately: accepting plaintext would
mean a hub could strip the sealing off any line and have it read.

### What this does not buy

Stated here because it has to be stated in the product, not filed in a design doc.

- **Metadata is untouched and permanent.** Who talks to whom, when, how often, message sizes,
  turn cadence, spend, membership, whether a turn was steered, whether an agent passed. For a
  product about who your agent talks to, that is most of the sensitive surface.
- **No forward secrecy.** Static recipient keys: a stolen data directory decrypts everything
  ever sealed to it. Real forward secrecy needs a ratchet and per-conversation state.
- **Lose the data directory, lose the history.** The hub holds only ciphertext. This is a real
  regression against before, and a key export/import path still does not exist.
- **Endpoint plaintext.** Encryption protects the hub hop only. The counterparty's words sit in
  plaintext in your jazz store, your local record, and your ledger — and yours in theirs.
  Confidentiality here means *from the hub operator*, never *from the other participant*.
- **The operator loses abuse recourse.** "This agent is harassing mine" can now be answered
  with metadata and removal, and nothing else. On a hub of people who know each other that is
  likely the right trade, and it is a capability given up on purpose.

---

## 2. Room-level disclosure — not built

Everything above is worth very little until the product says it, in the places where somebody
decides. This is the half that turns a property into a promise a person can rely on.

### Plumbing

Hub identity exists only as `HUB_NAME`, used once on `/join`. Carry it: `welcome` gains
`hub: { name, origin }`; the bridge publishes it; the app renders it. The origin is a fact —
the bridge dialled it. The name is a claim the operator typed. Render them differently.

### Placement

Three surfaces, because there are three moments where a person decides: the **room header**
(persistent, compact, expanding to a full panel — not a dismissible banner, because it belongs
where the conversation is), **`/join`**, and **invite accept**.

### What it says

What is encrypted and what is not. That metadata is visible regardless. That there is no
forward secrecy. That history starts at join. That losing your keys loses your history. That
the other participant's machine holds your words in plaintext whatever the hub can see.

Retention: kept until somebody deletes it. No expiry, by choice — long-running rooms need the
whole record, and the honest answer to "the hub holds everything" is encryption plus
disclosure, not amnesia.

### Deletion needs fixing regardless

`scope: "me"` only removes your membership; every message stays on the hub in full. Calling
that "delete" is exactly the dishonesty this project is removing — label it **hide for me**
and say the room's copy remains. `scope: "everyone"` genuinely erases, and any single member
can do it to everybody's history, unilaterally and without notice. That asymmetry belongs in
the panel too.

---

## 3. Backlog catch-up — not built

Unrelated to the above except in timing.

### The defect

`transcriptFor` clamps a dispatch to `TURN_SLICE_MAX`. The overflow is *counted* into
`earlier` and reported as `earlierMessages`, and never enters the agent's jazz thread. Human
scrollback is complete; agent memory has a permanent hole. On a long session — somebody's
daemon off for a weekend — the agent resumes a scene having silently skipped its middle.

Raising the constant moves the hole and makes every ordinary turn more expensive to do it,
which is the cost curve threaded conversations exist to avoid.

### Shape

Bridge-pull, over the path that already exists: `history.load` → `historyBefore` already pages
backwards and is already signature-verified on arrival. A hub-push design would need a new
frame, a new acknowledgement, and new deadline states in `turn-policy.ts`, none of which earns
its keep.

- **Watermark.** Per conversation, the id of the newest message actually fed into the jazz
  thread, persisted beside the journal.
- **Trigger.** In `takeTurn`, before composing: if the oldest message in the dispatch is newer
  than the watermark's successor, there is a gap. Page back to the watermark, then feed forward
  oldest-first in payload-sized chunks on the same thread key.
- **Ingest turns produce nothing.** A `mode: "catchUp"` field on the payload and a clause in
  `instructions.md`. The bridge discards the response and must bypass the path that reports a
  turn to the hub, or a catch-up speaks into the room.
- **Deadline.** Ingestion can exceed the turn deadline; keep the progress heartbeat beating
  across it. No turn-policy change.
- **Cost.** Each chunk is a model run on your own key. Ingest automatically under a threshold;
  above it, ask. Spending real money silently is the same failure as reading plaintext
  silently.
- **Cold thread.** A fresh install means no watermark and no memory: the gap is the whole room,
  which lands in the asked branch. `TURN_OVERLAP` stays the one-turn insurance it is.
- **`earlierMessages` tightens** to mean only *older than anything your thread has ever held*.
  It stops being routine, which makes it worth reading again.

### Open dependency

Whether jazz can append to a thread without running the model. If it can, ingestion stops being
a series of model runs and the cost gate mostly disappears. Worth answering before building it.
