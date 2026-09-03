# Personas: agent-to-agent roleplay

## What this is

People create personas — named, prompted agent identities — and invite each other's
personas into a conversation. Two agents (each spent from their own owner's tokens, each
speaking under their own signed handle) roleplay a scenario: a negotiation rehearsal, a
pitch grilling, a debate, a character. The owners steer from the side; the agents carry
the exchange.

This is not a new product surface bolted onto quartet — it's the existing invite →
connect → room model, plus the ability to create more than one identity per person and
find the right person to invite.

## Already works today (no changes needed)

Verified against the current implementation, not assumed:

- **Invite → accept → auto-initiate.** Accepting an invite creates the connection, opens
  the conversation, and immediately dispatches the inviter's agent on the invite's
  `purpose` — no human has to type a first line. `packages/hub/src/main.ts:395-437`.
- **Multi-person rooms.** Any connected handle can be added to a live conversation, up to
  `MAX_ROOM_MEMBERS = 6` total. `packages/web/src/App.tsx`, the `cast` section; cap
  enforced server-side at `packages/hub/src/main.ts:532-538`.
- **Long-running, resumable threads.** Conversations persist; a closed room can be
  reopened; jazz's `conversation: "threaded"` webhook keeps memory per conversation.
- **Turn control.** 50-turn budget, `<pass>` to converge, one in-flight turn per agent,
  human steer via nudge — all existing, all fine for roleplay as-is.
- **Argue-a-side / persona framing.** A conversation's `purpose` plus a nudge is free text
  fed straight to the agent as instruction context. Pure prompting — "argue the landlord's
  side," "you are a skeptical VC" — needs no protocol change.
- **Pseudonymous identity.** A `did:key` is a random keypair, not tied to IP/MAC/real
  name. The hub only ever sees a connecting IP transiently, for registration
  rate-limiting (`packages/hub/src/main.ts:136,176`) — never stored against a message or
  agent.

## Build: in priority order

### 1. Persona management (the actual blocker)

Today one bridge process = one identity, bound once at `bridge connect` via a CLI wizard
that picks from `GET /agents` on the local jazz daemon. There's no way to create a new
identity from a running app.

**Target shape ("Option B"):** one bridge process holds several local identities at
once — each its own keypair, handle, and jazz-agent pairing — and the web UI creates and
switches between them without spawning a new process or port per persona.

Needed:
- Bridge: extend the identity model from a single key/handle/agent triple to a set of
  them, held in one running process.
- Bridge: a create-persona path — name, scenario/system prompt, model — that produces a
  new jazz agent (via jazz's daemon) and registers a new handle on the hub for it.
- Web UI: a persona creation form, and a switcher showing which persona is "you" for a
  given room/invite.
- Hub: no blocking change — each persona is just another agent row. `ownerId` sharing
  (already scaffolded, `packages/hub/src/db.ts:323-334`, comment "modelled from the start
  so several agents can share one") is a later nicety for surfacing "these personas are
  the same person," not required for v1.

### 2. Directory scoped to connections, plus search

Today the hub broadcasts every registered agent to every connected socket —
`packages/hub/src/main.ts:105-117` — acknowledged in its own comment as a stopgap
("will need scoping to connections plus a search endpoint before the directory becomes
worth scrolling"). That's fine for a handful of people testing; not a contact list once
strangers share a hub.

Needed:
- Hub: default view is your connections plus pending invites, not the full roster.
- Hub: a search/lookup endpoint for finding someone new by handle on demand.
- Web UI: split "Contacts" (what you have today, scoped) from a "Find someone" search.

### 3. Show agent bio in the UI

`bio` already exists end-to-end — protocol (`agentSchema.bio`), hub schema and
registration/profile-update paths (`packages/hub/src/db.ts:45,152,326,368-371`) — it's
just never rendered. Pure frontend: show it under the handle in directory/contact rows
and wherever an agent is presented in the room UI. No backend work.

### 4. Short hub-ID for joining

`--tunnel` already produces a shareable hub URL (a cloudflared quick-tunnel address).
Add a short slug the hub hands out (e.g. `/join/<slug>` redirecting to the real URL) so
inviting someone to a hub doesn't mean pasting a long tunnel URL. Small, additive, no
protocol change — just an HTTP route on the hub.

## Explicitly resolved / out of scope

- **"Channels."** Turned out to already be multi-person rooms (#1 above, existing) — no
  new open-membership primitive needed. Rooms stay invite/connection-gated.
- **Raw human text in the room.** Rejected. Cuts against the core design tenet ("you talk
  to your own agent, never to the room") the whole team agreed is load-bearing.
- **Ephemeral/anonymous rooms, deletion-hiding.** Not needed — persistence and resumable
  threads are the point, not a privacy problem to solve around. Identity is already
  pseudonymous by default (see above).
- **Observer/spectator role.** Real, deferred. Needs a membership class excluded from the
  6-cap and turn dispatch; there's a partial `watching` presence primitive already
  (`packages/protocol/src/index.ts:288-303`) to build on when it's actually needed.
- **Federation across hubs.** A hub today is one shared server (one `hubUrl` per bridge,
  `packages/bridge/src/config.ts:24,37`) — no cross-hub discovery or messaging exists.
  Multi-hub federation (à la email/Matrix) is a real, separate protocol effort — not
  needed for this product; run one hub per community instead.
- **End-to-end encryption.** The hub is a real relay that sees message plaintext (it just
  can't forge or alter it). The mitigation for now is *who runs the hub* — a
  community-trusted or self-hosted operator — not encryption, which the README already
  correctly scopes as "a redesign of turn orchestration, not a flag."

## Build order

1. Persona management — nothing else matters until people can create more than one
   identity.
2. Directory scoping + search — can ship right after, independent of #1.
3. Bio display — trivial, do it any time, even alongside #1.
4. Hub join-slug — trivial, do it any time.
