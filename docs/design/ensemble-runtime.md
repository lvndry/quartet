# Ensemble runtime

Today a room converges by broadcast: a spoken message wakes every other member at once, each
pays for a turn, and each either speaks or passes (`turns.md`). That is the right primitive
for two people working something out, and the wrong one for five. This document describes
where the room is going — an **autonomous ensemble** — and, more importantly, the one thing
that has to be true before any of it is worth building.

It is a direction, not a shipped design. The broadcast runtime stays until the ensemble one
earns its place against the five-agent proof at the end. Both live behind the runtime seam
that already exists — the ensemble is a runtime, not a rewrite.

### What the room is for

You choose the cast and the premise. You press Start once. From there the agents decide, on
their own, when they have something worth saying — one speaks, another works quietly, a third
waits for the moment that is actually theirs, and the room falls quiet when nobody has a real
next move. You interrupt whenever you like, the way a person walking into a room does.

The user never picks who speaks next. That is the whole product: **a room where autonomous
agents understand when to take part, without being summoned.** Naming who speaks would make
it a workflow builder wearing a conversation's clothes.

The premise carries the social contract in plain language — "each of you give an independent
opinion" is an obligation on everyone; "debate this" invites disagreement; "role-play this
scene" makes a silence or a reversal a real contribution. These are interpretations the
agents make, not modes the product exposes.

### The gate: an attention pulse has to be cheap

Everything below rests on splitting one expensive act into two — a cheap decision *whether* to
speak, and the expensive *speaking* itself. That only pays if the cheap part is genuinely
cheap, and in this system "cheap" has an owner attached: a bid runs on the bidder's own key,
and a room event asks every eligible agent to bid. A lively five-agent room turns each reply
into four more bids.

So the first work is not the ladder or the mentions — it is a throwaway spike that answers one
question: **is a bid comfortably cheaper than a full turn, once the persona and goals are
cached rather than re-sent?** If a bid re-sends a character sheet every time, input tokens
dominate and a "small" model saves nothing. Measure the bid-to-turn cost ratio and the bids
per episode on a hardcoded five-persona room before touching the protocol, the schema, or the
sealing path. If the ratio is bad, the design is wrong and the rest of this document is
premature.

Get it right and the economics *improve* on today's: a five-agent turn goes from four full
runs (three peers plus the speaker, `turns.md`) to four cheap bids and one full run. The pulse
is not just what makes the room feel alive — it is what stops broadcast from spending four
owners' money to have three of them decide they had nothing to say.

### Attention, work, and speech are three grants, not one

A dispatch today grants computation and publication together. The ensemble splits them:

| | |
|---|---|
| **attention offer** | A stimulus asks an eligible agent to bid. Bounded and cheap; not a full turn. The agent returns a disposition — silent, react, work, speak, continue — and, if it wants the floor, why (it is answering a question, accepting an invitation, fulfilling an obligation, or self-selecting). |
| **work grant** | Permission to run privately — investigate, use tools. Several agents may hold one at once; private work is not the floor. |
| **publish lease** | The floor. Exactly one is valid at a time, fenced by an epoch and a base revision, and it authorises one bounded message. A candidate prepared against a room that has since moved must revise, withdraw, or ask for a new lease. |

The lease is the only correctness primitive that matters here, and it is the same shape as the
dispatch id it descends from (`turns.md`): minted by the hub, answerable once, checked against
the current revision inside the append transaction. At most one publisher per epoch, no stale
append — those are the two properties the fuzz tests exist to defend.

### The room is a stage manager, not a director

Quartet decides *timing and standing*: who holds the floor, whether an invitation or an
obligation is structurally real, whether a candidate was prepared against stale state, whether
an episode has spent its budget, whether a message may publish. Quartet does not decide
*meaning*: whether an argument is right, whether a reaction matters, whether tension should
rise, whether a joke or a betrayal earns its place. It cannot — it holds sealed blobs
(`confidentiality.md`) — and it should not want to. Those judgments live in each Jazz agent,
which has the persona, the memory, the decrypted transcript, and the tools.

The floor is allocated by conversational rights, in order, never by a score the hub cannot
justify:

1. Human input.
2. An open, direct obligation — a question, a handoff, a commitment made to this agent.
3. A completed piece of granted private work.
4. An invitation from the current speaker.
5. An agent that self-selects.
6. The current speaker continuing.
7. Nobody claims the moment — the room goes quiet.

Fairness is a tie-break, not a goal. A detective may dominate an investigation; a witness may
speak once and change everything. Among equal self-selections, prefer continuing an existing
exchange over forcing equal airtime, break ties with a seed rather than latency, and track
whose *bids to speak* keep losing rather than who has merely been quiet — the hub can see that
an agent wanted the floor and did not get it, which is content-blind and therefore something
it is allowed to know.

### Desire is the agent's; arbitration is the room's

The bid is per-agent from the start, not a central model choosing for everyone. A single
selector reading every persona produces the *appearance* of five agents while one hidden agent
runs the cast — and it puts every participation decision on one key. That is the opposite of
the product. The danger the old designs warned about — N models electing one speaker with no
coordinator — does not apply, because the room *is* the coordinator: agents bid their own
desire on their own key, and Quartet arbitrates collisions by the ladder above. First version
may run the bid on the same model as the turn, with a tiny structured output and tools off;
optimise to a smaller or local model later.

### The lifecycle

```
quiet → assessing → preparing → publishing → assessing → quiet | waiting-for-human | stopped
```

An **episode** is one causal run, opened by human input or an external event, advancing a
monotonic room revision on every shared event. Agent invitations and replies belong to the
episode that provoked them rather than resetting its budget — that is what makes loop
containment and stale-output detection possible, and what makes a human interruption reliably
land against the right revision.

A room continues without further human prompting while meaningful bids, obligations, or work
remain. It becomes quiet only when there is no valid lease, no eligible bid, no active work, no
ready result, no runnable obligation, and no live invitation. Quiet is a state the room reaches
honestly and records as one of: a natural pause, waiting for a person, a finished outcome, a
human stop, budget exhausted, a safety breaker, or a runtime failure. Agents do not publish
"we're done" to close the loop — silence that is really silence is allowed to be silence.

### Obligations and invitations are structural, and derived from signed intent

An obligation is a record the hub keeps — who owes what kind of response, and whether it is
open. Because the hub cannot read a message, an obligation is never inferred from content: it
is derived from the *signed intent* on a mention (below) or asserted by the author's own
bridge. A human address creates a strong obligation; an agent handoff needs a real work item
or obligation behind it; an invitation gives its target first refusal, and if the target
declines or is away, the floor opens normally. Reciprocal invitations with nothing changed do
not manufacture new obligations — that is one of the loops the room must not fall into.

### Mentions carry intent

Names people read and identities the system routes by are separate — a readable `@codex` over
a signed recipient did, so a hub cannot retarget a mention (`identity.md`). On top of that, a
mention carries what it is *for*:

| | |
|---|---|
| `reference` | "Codex said something earlier." Visual only. |
| `address` | "Codex, answer this." |
| `invite` | "Codex should go next." |
| `handoff` | "Codex owns this now." |

All four render the same way to a reader; only the last three touch attention. This is the
line that keeps "we're waiting on @codex" from mechanically waking Codex — a narrative mention
is not a summons. It is also why a bare highlight can ship first and the signed-intent
plumbing can wait for the arbiter that consumes it: the visual half improves today's rooms;
the routing half is inert until there is a scheduler to read it.

### Structural loop containment

Jazz provides the semantic restraint — an agent that knows the moment is not its own stays
quiet. Quartet provides the structural backstop that does not depend on every agent behaving:
an autonomous-turn budget per episode, A↔B reciprocal-handoff detection, same-speaker streak
limits, rejection of a reused lease, a cap on concurrent private work, a ceiling on episode
time and cost, a cooldown after a breaker trips, and human input that resets or starts a fresh
episode. Bowing out stays exactly as it is (`rooms.md`): an agent's own decision, reversible
only by its own owner — in the ensemble it reads as "attention off until my owner brings me
back," and it remains the owner-side circuit breaker on spend that nothing a peer does can
lift.

### The proof

The first thing to demonstrate is autonomous roleplay, because it exposes bad timing,
dominance, repetition, and persona collapse faster than any task does. One premise, five
distinct personas, six to twelve coherent turns with no further conducting, recognisable
voices, no stale pile-on, no acknowledgement loop, a quiet character left quiet, at least one
surprising-but-apt intervention, a natural pause, and a human interruption that lands
immediately and invalidates stale work. The primary metric is **useful autonomous progress per
human intervention**; the cost-per-accepted-contribution and the correct- versus
premature-silence rates are how we know the pulse and the ladder are tuned. If that feels
alive — and stays affordable — the same runtime grows into research, planning, and software
work, where completed background work becomes a new stimulus that must bid for the floor like
anyone else.
