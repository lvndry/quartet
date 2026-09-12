# Solo rooms

**Status: §1, §2, §5's thread key aside, §7 and the prompt in §4 are built. §3 (a webhook
per sandbox), §5 (reset) and §6's warning copy are not.** A room whose member table holds one
agent, so the first thing a person can do with quartet is watch their own agent take a turn.

What works today: **Try out <agent>** on the agent editor in the roster opens a room with one
member and lands you in it, a steer takes a turn there, and the answer is sealed to the only
member the room has. The button appears only for the agent that is **on stage**, because §3 is
what makes it honest anywhere else.

---

## Why

The smallest real thing quartet can do currently costs two identities, two bridges and two
ports. `docs/a-room-of-personas.md` step 3 is the honest version of that — three
`quartet connect` processes to see three personas disagree — and `invite.send` refuses a
self-invite outright (`packages/hub/src/main.ts:787`), because a connection is a pair and
inviting yourself is not a relationship.

So the first turn anybody watches is one that spends a stranger's money and speaks in their
name. That is the wrong first turn. Everything a person wants to know before pointing an
agent at somebody else — does this persona sound like anything, does it use the tools I
allowed, does it stop when told, what does a steer actually do — is answerable in a room with
nobody else in it, and there is nowhere to ask it.

This is an activation fix, not a distribution one. A room of one is not interesting to share;
it is what makes the roster do something the day it is created.

## 1. What a solo room is

A conversation whose `conversation_members` holds one row. Not a new object — the existing one
at n=1.

`docs/design/rooms.md` already makes this legal, in the sentence that separated membership
from connections: *"The connection is still a pair — it is the right model for a relationship —
it is just where a room started, not who is in it."* A solo room started nowhere. That is the
whole of the model, and the two subsystems that would be expected to need special cases do not.

### The turn policy needs no change

| event at n=1 | what `decide` already does |
|---|---|
| `message` | `pokeAll(state, othersThan(state, event.author))` over an empty list — nothing (`turn-policy.ts:277`). An agent's own line does not wake it, which is the rule a room of six needs and exactly the rule a room of one needs. |
| `steer` | `poke(refilled, event.agent, …)` — one dispatch (`turn-policy.ts:296`). It lifts a halt, refills a spent turn allowance and takes back a goodbye, because speaking to your own agent means carry on. |
| `settled` with `spoke` | The room goes quiet and waits for you. There is nobody to wake. |
| `stop`, `reopen`, `limit`, `deadline`, `offline`, `arrived` | Unchanged. `<pass>` and `<end>` mean what they mean. |

One steer, one turn. That is the sandbox's entire cadence and it falls out of rules that are
already there.

The one rule that does still say a room needs two people is `left`: a member walking out drops
the room to `closed` when fewer than two remain (`turn-policy.ts:396`). That stays, and it is
not an oversight to fix later. A room somebody opened *as* a pair and then left is not a
sandbox, and turning it into one silently would be the room deciding on its own to become a
different kind of thing. A solo room is something a person asks for by name; `reopen` is there
for anybody who wants the leftovers.
 What it needs is not a branch but coverage: `turn-policy.test.ts` and
`turn-policy.fuzz.test.ts` should generate single-member rooms, so "a room of one spends
nothing on its own" becomes a property rather than a thing that happens to be true today.

### Sealing needs no change

`recipientsFor` skips the caller (`sealer.ts:64`), so a one-member roster resolves to an empty
recipient list, and `Sealer.toRoom` adds the sender itself rather than trusting it to appear
(`sealer.ts:139`). Sealing to yourself alone is already a live path — it is what a steer does,
as `toSelf` (`sealer.ts:144`). A solo room's lines travel the same way, and the room reads back.

No member without a published key, so the refusal in `recipientsFor` cannot fire; no pin to
check in `known.ts`, because there is no counterparty to be substituted. A solo room is the one
room where the hub has nothing to attack.

## 2. The hub

### One new frame

    { t: "conversation.solo", purpose: string, limit?: Limit }

The hub creates a conversation with the caller as its only member and replies with the
`conversation` frame it sends for any other room. Rate limiting is the existing per-socket
token bucket; nothing here is cheaper to ask for than `conversation.open` already is.

### `connection_id` becomes nullable

`conversations.connection_id` is `TEXT NOT NULL REFERENCES connections(id)`
(`db.ts:211`). A solo room has no connection, so the column drops `NOT NULL` and
`createSoloConversation(agentId, purpose, limit)` inserts `NULL` beside one `addMember`.
`conversationSchema.connectionId` (`protocol/src/index.ts:266`) becomes `.optional()`; the
only consumer of the field is the bridge's own open route, which reads it from a request body
rather than from a room (`bridge/src/local.ts:480`), so nothing in the app follows.

Per `limits.md` — pre-release, so no migrations — the answer to an existing hub database is to
clear it.

**Rejected: a self-connection row.** `connections` has `UNIQUE (a_agent, b_agent)` and
`HubStore.pair` sorts, so `(x, x)` inserts happily and `createConversation` would produce a
one-member room with no other change at all. It is the cheaper patch and it lies: a connection
is somebody agreeing to talk to you, `connectionsFor` would return you as your own `other`
(`db.ts:482`), and you would appear in your own contact list. A nullable column says the true
thing — this room started nowhere — and the lie would have leaked into the directory UI on the
first render.

### Live, not proposed

`proposed` exists because the first turn of a room opened on an existing connection spends the
other owner's money and speaks in their name, so it waits for them. There is no other owner.
Asking yourself for consent is the same noise the invite-accept path already refuses to make
(`main.ts:849`): a solo room is created `live`.

### Nothing dispatches on create

Unlike `invite.respond`, which calls `orchestrator.onBegin` because the purpose line was
somebody's stated reason for wanting the conversation, a sandbox is opened by pressing a
button. Spending a turn before the person has typed anything is spending money on a click. The
first steer is the first turn.

### What already works, unchanged

`conversation.stop` and `reopen`; `limit.set`; `conversation.leave`, which leaves a room with
no members and closes it; and `conversation.delete` with `scope: "everyone"`, which erases once
every current member has asked — so a sandbox is the one room a person can actually delete
outright rather than hide. Worth saying in the product, given that `confidentiality.md` §2 is
still owed a fix for how "delete" reads everywhere else.

## 3. Which agent answers

This is the part that is not free.

One bridge speaks as one agent: the on-stage agent is whichever one quartet's webhook entry
points at, and putting a different one on stage rewrites that entry
(`agent-admin.ts:206`). The stage is global. A **Test** button next to a persona on the roster
that quietly moved it would change who answers your friend's room, mid-conversation, as a side
effect of curiosity — in the feature whose entire purpose is to be the safe place to be
curious.

**A sandbox dispatches through its own webhook.** `ensureJazzWebhook` merges one entry into
jazz's config by name and touches nothing else (`jazz.ts:482`), and webhook tokens are keyed by
name (`webhookTokenEnvVar`, `jazz.ts:540`), so a second entry — `quartet-<label>-sandbox`,
pointed at the agent under test — is a supported shape rather than a trick. `runTurn` already
takes its `DaemonSettings` as an argument (`bridge.ts:1285`), so the change at the call site is
`this.daemon` becoming `this.daemonFor(conversationId)`: the default for every room, the
sandbox entry for a sandbox room.

The costs, rather than discovering them later:

| | |
|---|---|
| A token minted while serving | `resolveOrMintToken` shells `jazz webhook token` (`main.ts:578`), which today happens at `connect` with a terminal to complain to. The sandbox path mints on first use from inside the bridge. There is precedent — `jazz-secrets.ts` already shells `jazz config set` for the agents page — and there is a new failure mode: jazz not on the bridge's `PATH`. It fails as a refusal on the button, naming the command, not as a room that never answers. |
| A second name `agentIdFor` must know | It reads which agent a webhook wakes as a fallback (`jazz.ts:465`). Two entries means two answers, and the sandbox's is not the stage's. Whichever call site asks "who speaks for me" has to keep asking about the stage. |
| One more keyring entry per identity | Stated in `local-files.md` when it lands. |

**Rejected: offer Test only for the on-stage agent.** It is free, and it makes the button
absent exactly when it is most useful — you have just written a persona, it is not on stage,
and the thing you want is to see it speak without committing to it.

**Rejected: a per-conversation `agentId` with no second webhook.** There is nowhere to put it.
The webhook entry *is* what decides which agent jazz wakes; a room-level field would be a
preference the daemon never sees.

The reason to pay for this once is that it is the same mechanism the next rung needs: one
bridge carrying several agents is what "one human, several agents in one room" costs, and it is
currently paid for with one process and one port per persona.

## 4. What the agent is told

`instructions.md` opens: *"You are in a conversation with one or more other agents. Each of you
acts for a different person, and each of you runs on that person's own machine."* At n=1 that
is false, and the rest of the template leans on it — the transcript is described as somebody
else's words, and `<pass>` is explained as how a room of several converges.

**One template, reworded so an empty `speakingWith` is a true case rather than an exception.**
The opening states what the room is and defers to the payload for who is in it: other agents
when there are any, and when there are none, the operator who is testing you. Every behavioural
rule stays byte-identical — sentinels, steer precedence over transcript, no greeting, read the
purpose for what it asks.

**Rejected: a sandbox template.** A second template drifts, and the day it does, the sandbox
stops testing the thing it is for. The payload already carries the fact:
`speakingWith: readonly string[]` has been a list since rooms stopped being pairs
(`prompt.ts:31`), and `[]` is representable with no change to the composer.

The residual, which belongs in the product and not only here: a solo room is a faithful test of
a persona, a model, a toolset and whether an agent follows a steer. It is not a test of how that
agent behaves *toward another agent*, because there is not one. That still takes a second
member — which §6 is the one-click path to.

## 5. Reset

The jazz thread key is the conversation id, passed straight through (`bridge.ts:1285-1291`).
One room is one thread, which is what keeps last week's argument out of today's.

Reset mints a new one: the key becomes `<conversationId>` at epoch 0 and
`<conversationId>#<n>` after the nth reset. Epoch 0 keeps the bare id so no existing room
re-threads on upgrade and no agent loses a memory to a deploy.

**The epoch is a count of reset markers in `asides.jsonl`.** Asides are already durable,
already local-only, already appended and read back at startup (`ledger.ts:73`, `bridge.ts:290`),
and already merged into the app's timeline for display. A marker is an `Aside` with
`kind: "reset"` — a field the existing reader preserves, since it validates `text` and
`conversationId` and keeps the rest. So the thing on screen *is* the state, rather than a
second file that can disagree with the divider the person is looking at.

**Reset is a bridge-local act and the hub is not told.** Which thread this machine's daemon
resumes is not the hub's business, and a hub-side epoch would be the hub reaching into an
agent's memory. It also means reset works in every room, not only a sandbox — which is worth
having, and worth labelling precisely: it means *my agent forgets this room*, never *this room
is erased*. The hub's transcript, the counterparty's copy and your own `sent.jsonl` are all
untouched, and the app keeps rendering every line above the divider.

What it does not reset is the agent's memory scopes. A fresh thread is a fresh conversation, not
a fresh agent: whatever jazz wrote to a memory the agent may read is still there, and a sandbox
turn that writes one can change how that agent answers a real room. Whether jazz writes
memories mid-turn, and whether a scope can be narrowed per webhook, is the open question here —
worth answering before the word *sandbox* appears in the UI, because the word promises isolation
this does not have.

## 6. Promote

`conversation.add` is already the whole feature. It checks the *adder's* connection with the
person joining (`main.ts:989`), never the room's own origin, so a room with a null
`connection_id` grows exactly like any other, and the control exists in the app already
(`App.tsx:1343`). The room keeps its absent `connectionId` for life, which stays true: it
started nowhere.

Two things to say out loud at the moment somebody presses it:

- **History starts at join.** Every line of the sandbox was sealed to one recipient, so the
  newcomer gets the room with the existing `sealed-to-others` rendering for all of it — "a line
  you have no key for". That is the documented semantic (`confidentiality.md`), and in this one
  flow it is the *normal* case rather than an edge. **Built:** the add row in a room of one
  says so above the handle field, before the add rather than after, once there is any history
  to lose.
- **`onJoined` owes them a turn** (`main.ts:1015`), and their first turn is a room whose history
  they cannot read. A reset before promoting is the clean version of this, which is an argument
  for putting the two controls next to each other.

## 7. The app

**The button goes on the agent, not on the persona.** A persona is a jazz file; what takes a
turn is an agent — persona plus model, tools, memory scopes — so testing a persona alone would
test something that never speaks. The roster row in `Dashboard.tsx` is where it belongs.

Two places assume a room has somebody else in it, and both degrade rather than break:

- `nameThem([])` returns `"nobody"` (`App.tsx:65`), so a sandbox row in the sidebar reads
  "nobody · 50 turns".
- the monogram falls back to an empty string (`App.tsx:959`).

Both want the same answer: a solo room is named after the agent under test, not after who else
is in it.

What already works and should be left alone: your own agent's live state renders from
`activity` rather than from peer presence (`App.tsx:1437`), so thinking, tool calls and
approvals all appear; `presence` is empty and correctly so; and asides already merge into the
timeline, which is what the reset divider rides on.

## 8. What this does not do

| | |
|---|---|
| **It is not private from the hub.** | Rooms are sealed, metadata is not, permanently — that a room exists, its size, its cadence, its spend (`limits.md`). "Private sandbox" means unreadable by the operator, not invisible to them. The word needs care in the UI. |
| **No hub, no room.** | A room is hub state. A solo room needs the socket the app already needed, and there is no offline mode here. |
| **No persona editing.** | The app writes new personas and cannot change existing ones (`Dashboard.tsx:599`); editing is still `jazz persona edit`. Editing from inside the sandbox needs a jazz update path that does not exist yet. |
| **No fork.** | Seeding a new thread from a point in an old one means replaying messages into jazz, which is the open dependency in `confidentiality.md` §3 — whether a thread can be appended to without running the model. Until that is answered, a fork costs a model run per chunk and is not worth shipping. |
| **No memory isolation.** | §5. |
| **No guest link.** | Somebody else talking to your agent is a different project: it needs a human message kind, a page the hub serves, and a room the hub can read. None of that is here, and none of it should arrive as a side effect of this. |

## 9. Tests worth writing

- `turn-policy`: single-member rooms in both the unit tests and the fuzz generator, with "a
  solo room dispatches only on a steer" as the property.
- `db`: a solo conversation round-trips with an absent `connectionId`; leaving closes it;
  `scope: "everyone"` erases it in one ask.
- `hardening`: `conversation.solo` from an unauthenticated socket is refused, and a solo room
  cannot be grown to a second member without a connection.
- `sealer`: a line sealed in a one-member room opens again on the same bridge.
- `prompt`: `speakingWith: []` composes a payload whose instructions are true.
- `smoke`: one bridge, one agent, `conversation.solo`, one steer, one answer — no second port.
