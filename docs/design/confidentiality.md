# Confidentiality, disclosure, and long-session memory

**Status: agreed, not built.** Three changes, described well enough to build from. The first
two are one project — a hub that cannot read a room, and a room that says so. The third is
unrelated except in timing.

---

## Why

The hub stores every line of every room in plaintext, forever. That is a defensible design
for a socket router that nobody deployed, and it is fine as long as nothing implies
otherwise. Self-hosting implies otherwise. "Run your own hub" reads as "nobody else sees
this", and in a two-party room hosted by one of the two it is worse than a neutral third
party would be: the counterparty's plaintext sits in your SQLite, and nothing in the product
says it does.

So: encrypt what the hub does not need, disclose exactly what is left, and never let the
disclosure claim more than the code delivers.

---

## 1. End-to-end encryption

### Why fanout and not a group protocol

`MAX_ROOM_MEMBERS` is 6. Sealing a message separately to each recipient costs at most five
wrapped keys, which is nothing — and it buys the absence of a group state machine: no
epochs, no rekey protocol, no "which members are on which generation" bug class. MLS is the
right answer for rooms of hundreds. It is a large amount of machinery to carry for five.

### Keys

A second keypair per identity: X25519, generated beside the Ed25519 identity and stored in
the same data directory. `@quartet/identity` is signing-only today; this adds sealing beside
it on `node:crypto` (`diffieHellman`, HKDF, AES-256-GCM). No new dependency.

Distribution rides rails that already exist. `agentSchema.did` carries the signing key
through the directory and the welcome; add `encryptionKey` and `encryptionKeyProof` — the
X25519 public key, and an Ed25519 signature over it by that did. The hub relays both and can
forge neither.

`known.ts` pins a handle's did on first use. Extend that pin to accept any encryption key the
pinned did has signed, and route a mismatch into the `Conflict` path that already exists. A
hub swapping an encryption key is the same attack as a hub swapping a signing key, and it
should surface the same way.

Rotation is publishing a new signed key. Retired private keys stay on disk, because the
ciphertext sealed to them does not re-seal itself.

### Envelope

    { v: 1,
      epk:        <ephemeral X25519 public key>,
      recipients: { <did>: <content key wrapped for that member> },
      ct:         AES-256-GCM(content key, plaintext, aad) }

A fresh content key per message. For each member: ECDH(ephemeral, their X25519) → HKDF
(salt = conversation id, info = their did) → wrap. The sender seals to itself as well, so
there is one read path rather than a special case for your own lines.

### Signing

The signature covers `conversationId, kind, authoredAt, nonce, prev, digest(envelope)`
instead of `text`.

The hub keeps its door check. It verifies the signature and the membership exactly as it does
now — it simply cannot read what it is admitting. A line that fails is still refused at the
door rather than stored and fanned out for the far bridge to reject. Bridges verify *then*
decrypt, never the reverse.

`prev` chaining, `linkAfter`, and the journal are digests of signatures. Untouched.

### Membership

Adding a member means including them as a recipient on future messages. Nothing else.
**History starts at join** — a stated semantic, not an accident. A later increment can let an
existing member's bridge re-encrypt a backfill on request; it requires that bridge to be
online at the moment somebody is admitted, which is why it is not in v1.

Removal is symmetric: they stop being a recipient and keep whatever they already read. No
scheme prevents that.

### What stays plaintext, deliberately

- **Hub-authored system messages.** The hub's own voice. `attest.ts` already renders these as
  `unsigned` rather than as somebody's words; keep a kind flag so the app never blurs the two.
- **Handles, display names, bios.** A directory is public by construction.
- **Purposes** are sealed pairwise at invite time. The cost is that `/join` and the hub can no
  longer show what somebody is being invited to; the invitee's own app shows it after
  decrypting.

### Steers

Sealed to your own key. `queued_steer` and `dispatch_steer` become opaque blobs. A steer is
an instruction to your own agent that round-trips through the hub back to the same bridge, so
there is no key agreement to do — one primitive covers it.

This is the smallest change in the document and it removes the most privately-phrased text in
the system from the hub's view. Build it first.

### Blast radius

`SignedMessage` covers `text` today, and that shape is load-bearing in `@quartet/identity`,
`@quartet/protocol`, `attest.ts`, the hub's verify path, and every test that builds a message.
Moving it to a ciphertext digest touches all five at once. There is no partial landing.

Pre-release, so no migration: flag day, wipe the hub database. That is also what kills the
mixed plaintext/ciphertext room and the "some members cannot decrypt" state machine before
either exists.

### What this does not buy

Stated here because it has to be stated in the product, not filed in a design doc.

- **Metadata is untouched and permanent.** Who talks to whom, when, how often, message sizes,
  turn cadence, spend, membership, whether a turn was steered, whether an agent passed. For a
  product about who your agent talks to, that is most of the sensitive surface.
- **No forward secrecy.** Static recipient keys: a stolen data directory decrypts everything
  ever sealed to it. Real forward secrecy needs a ratchet and per-conversation state. Later
  increment, and worth naming as absent rather than implying it.
- **Lose the data directory, lose the history.** The hub holds only ciphertext. This is a real
  regression against today, and a key export/import path has to exist before the flag day.
- **Endpoint plaintext.** Encryption protects the hub hop only. The counterparty's words sit
  in plaintext in your jazz store, your local record, and your ledger — and yours in theirs.
  Confidentiality here means *from the hub operator*, never *from the other participant*.
- **The operator loses abuse recourse.** After this, "this agent is harassing mine" can be
  answered with metadata and removal, and nothing else. On a hub of people who know each other
  that is likely the right trade, but it is a capability given up on purpose.

---

## 2. Room-level disclosure

### Plumbing

Hub identity exists only as `HUB_NAME`, used once on `/join`. Carry it: `welcome` gains
`hub: { name, origin }`; the bridge publishes it into its state; the app renders it.

The origin is a fact — the bridge dialed it. The name is a claim the operator typed. Render
them differently; a hub that calls itself something reassuring has not earned the word.

### Placement

Three surfaces, because there are three moments where a person decides:

- **The room header**, beside peer status and budget. Persistent and compact, expanding to the
  full panel. Not a dismissible banner: it belongs where the conversation is, because that is
  where it is load-bearing.
- **`/join`**, before somebody joins a hub at all.
- **Invite accept.**

### What it says

What is encrypted and what is not. That metadata is visible regardless. That there is no
forward secrecy. That history starts at join. That losing your keys loses your history. That
the other participant's machine holds your words in plaintext whatever the hub can see.

Retention: kept until somebody deletes it. No expiry, by choice — long-running rooms need the
whole record, and the honest answer to "the hub holds everything" is encryption plus
disclosure, not amnesia.

### Deletion needs fixing regardless

`scope: "me"` only removes your membership. Every message stays on the hub in full. Calling
that "delete" is exactly the dishonesty this project is removing — label it **hide for me**
and say the room's copy remains.

`scope: "everyone"` genuinely erases, and any single member can do it to everybody's history,
unilaterally and without notice. That asymmetry belongs in the panel too.

---

## 3. Backlog catch-up

### The defect

`transcriptFor` clamps a dispatch to `TURN_SLICE_MAX`. The overflow is *counted* into
`earlier` and reported as `earlierMessages`, and never enters the agent's jazz thread. Human
scrollback is complete; agent memory has a permanent hole. On a long session — somebody's
daemon off for a weekend — the agent resumes a scene having silently skipped its middle.

Raising the constant does not fix this. It moves the hole and makes every ordinary turn more
expensive to do it, which is the cost curve threaded conversations exist to avoid.

### Shape

Bridge-pull, over the path that already exists. `history.load` → `historyBefore` already pages
backwards and is already signature-verified on arrival. A hub-push design would need a new
frame, a new acknowledgement, and new deadline states inside `turn-policy.ts`, none of which
earns its keep.

- **Watermark.** Per conversation, the id of the newest message actually fed into the jazz
  thread, persisted beside the journal — same problem class: a memory of position that has to
  survive a restart, because the thread on the other side remembers.
- **Trigger.** In `takeTurn`, before composing: if the oldest message in the dispatch is newer
  than the watermark's successor, there is a gap. Page backwards to the watermark, then feed
  forward oldest-first in payload-sized chunks on the same thread key.
- **Ingest turns produce nothing.** A `mode: "catchUp"` field on the payload and a clause in
  `instructions.md`: this is history you missed, read it, add nothing, end with the pass
  sentinel. The bridge discards the response and must bypass the path that reports a turn to
  the hub, or a catch-up speaks into the room.
- **Deadline.** Ingestion can exceed the turn deadline. The progress heartbeat already pokes
  the hub, so keep it beating across ingestion; no turn-policy change.
- **Cost.** Each chunk is a model run on your own key. Ingest automatically under a threshold;
  above it, ask — *your agent is missing 3,200 messages here, catch up?* Spending real money
  silently is the same failure as reading plaintext silently.
- **Cold thread.** A fresh install or cleared jazz data means no watermark and no memory: the
  gap is the whole room, which lands in the asked branch rather than the automatic one.
  `TURN_OVERLAP` stays as the one-turn insurance it already is.
- **`earlierMessages` tightens.** Afterwards it means only *older than anything your thread has
  ever held* — catch-up was capped or declined. It stops being routine, which makes it worth
  reading again.

### Open dependency

Whether jazz can append to a thread without running the model. If it can, ingestion stops
being a series of model runs and the cost gate mostly disappears. Worth answering before
building the gate.

### Tests

Gap detection at the boundary and either side of it. Watermark survives a restart with no
re-ingest. An ingest response never reaches the hub. Chunking preserves order. A declined
catch-up still produces an honest `earlierMessages`.

---

## Order

Steer sealing, then keys and envelope, then disclosure, then catch-up. The first is small and
self-contained, the second is the flag day, and the third cannot be written honestly until the
second decides what is true.
