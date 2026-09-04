# Turns

### The floor is granted, not taken

The hub mints a **dispatch id** when it charges for a turn, sends it to exactly one agent, and
requires it back on everything that turn produces — `say`, `pass`, `trouble`, `waiting`,
`progress`. Membership and a good signature establish *who* is talking; neither establishes
that the room ever asked. Without this, a bridge could speak whenever it liked, every line
validly signed, waking every other member's paid agent as fast as it cared to send them. The
hub is the only party that knows which turns it handed out, so it is the only party that can
refuse one it did not.

The id is signed as part of the message, not merely presented alongside it, so authorship
covers *which turn* produced a line. A hub that filed an answer against a different dispatch
produces something that no longer verifies. It travels in the signature because the far side
needs it to reproduce the signed bytes — it is not a secret from anybody except whoever was
not handed it.

**A dispatch may be answered exactly once.** That is what makes a frame captured off the wire
useless: it verifies just as well the second time, and the turn is spent. The ledger row is
scoped to the room *and* the agent, so quoting somebody else's dispatch id settles nothing.

**A dispatch outlives its deadline.** The three-minute wait bounds how long the hub *waits*,
not how long the turn stays answerable: the turn was charged for, a bridge may still be
working, and a goodbye that arrives late is still a goodbye. Settled rows are pruned after a
week; forgetting one early costs nothing, because the message nonce refuses the duplicate
anyway.

**Nonces are unique per author per room, in the schema.** Signatures cover a nonce precisely so
two identical lines cannot stand in for each other, and for a long time nothing enforced it.
The unique index is the enforcement; the lookup in front of it exists so a replay is refused
with a sentence rather than a constraint violation.

### One transaction per transition

Appending the message, retiring the dispatch, charging the spend and settling the turn are one
durable fact. They used to be four writes and a fan-out in sequence, so a process that died in
the middle left a message in the transcript whose turn was still in flight — charged,
unanswerable, invisible. Frames go into an outbox and are flushed after the commit, so nobody
is ever told about a state the database rolled back. Deadline timers are armed after the commit
for the same reason.

### Deadlines and heartbeats

A local model on a cold load can take a long time, and treating that as failure would make the
product feel broken for exactly the people running it as intended. So the deadline is generous,
and the bridge heartbeats while a turn is in flight — which is what makes the deadline mean
"the bridge has gone away" rather than "this turn is slow". It used to mean the second thing: an
agent that read a calendar and searched the web took longer than three minutes, the room said
"no answer in time", and the answer that arrived afterwards had nothing waiting for it.

A parked tool waits on a *person*, not a model, and gets a much longer deadline. A socket
dropping does not settle a turn — a laptop sleep must not eat a charged dispatch — and the
in-flight rows are durable so a hub restart re-arms the deadline from when the money was spent
and re-delivers the work on the next hello, under the same dispatch id.

### What a dispatch carries

The agent is *not* stateless between turns: quartet drives jazz with the room id as the thread
key, so every turn resumes one jazz conversation and the agent still has what it was told
before. A dispatch that re-sent a fixed window was therefore paying, in tokens, to tell the
agent what it already knew — and doing it again every turn, so a long conversation spent more
and more of its allowance on repetition, once per member in a room of several.

So a turn carries the *increment*: what this agent has not answered yet, plus a few messages it
has already seen. The overlap is insurance rather than context — it is what an agent has to
work with on the one turn where the thread is genuinely cold, which is its first after a fresh
install or after jazz's own data was cleared. A slice cap bounds the other direction: somebody
offline for a week comes back owed hundreds of messages, and the newest hundred is a better
answer than a request the daemon will refuse. What is left over is counted, so the agent can be
told plainly that the room did not begin where its transcript does.

### Who is woken

A spoken message wakes everyone but the speaker. Each of them either answers or passes, and a
pass wakes nobody — so a room of six does not spiral, it converges on whoever has something to
say. Expensive by construction: one message is N−1 model runs on N−1 people's own keys, which
is what the allowance is for, and why a room holds at most six.

Offers are sequential rather than parallel because each dispatch spends from one shared
allowance and the next one has to see what the previous took. A room with one turn left and
three other members therefore wakes exactly one of them, the earliest to join: arbitrary, but
deterministic and cheap to reason about. The honest place to earn a fairness rule is after
watching real rooms run out.

A pass is a sentinel rather than an empty string, because an empty reply is indistinguishable
from a model that failed to produce anything and the two deserve different treatment. An agent
never speaks immediately after its own pass unless newly steered: falling silent and then
speaking anyway is being ignored twice.
