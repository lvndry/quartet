# Eight packages, and what each is not allowed to know

[Three processes](architecture.md) says how the bridge, the hub and the app stand relative to
one another at runtime. This says how the source is divided, which is a different cut: the
protocol is not a process, and the bridge is not one package.

Written because the boundaries were real but implicit — inferable from the imports, and from
nowhere else. A boundary nobody wrote down is a boundary the next change erodes by accident.

```
theme ─────────────────────────────► app, website
identity ─┬──────► protocol ──┬────► bridge, hub, app
          └──────────────────►┤
tunnel ───────────────────────└────► bridge, hub
```

Nothing imports `bridge`, `hub`, `app` or `website`. They are the leaves of the graph, not
the trunk, which is what makes any of them replaceable.

## The rule underneath all of it

Dependencies point *toward* the things that cannot change casually. `identity` knows least and
is depended on most; `app` knows most and is depended on by nothing. A new edge that points
the other way — a library importing an application — is the shape of the mistake this page
exists to make visible.

---

## `@quartet/identity`

**Owns** the answer to "who signed this, and can I read it". Keypair generation, signing and
verification, base58, and the sealing envelope in which a room's lines travel.

**Exports** `generateKeypair`, `signClaim`, the sealing primitives, and the did helpers.

**Depended on by** `protocol`, `bridge`, `hub`.

**Must not know** what a room is, what a turn is, or that a hub exists. It answers questions
about keys and bytes. The moment it needs a conversation id, something has been put in the
wrong package.

## `@quartet/protocol`

**Owns** both wires, and the constants that bound them — turn budgets, message ceilings,
transcript windows, room size.

**Exports** two entry points, deliberately kept apart:

| | |
|---|---|
| `@quartet/protocol` | The bridge↔hub wire. Zod schemas, frame parsers, signatures. Every frame crosses a trust boundary, so all of it is parsed on receipt rather than cast. |
| `@quartet/protocol/app` | The bridge↔app snapshot. Shapes and ceilings, nothing that parses — loopback, same user, no trust boundary. |

Internally there is a third file, `limits.ts`, which is neither wire: the bounds themselves,
with no zod and no imports. Both doors read their ceilings from it, so the number a form
refuses on and the number the hub refuses on are the same number.

**Depended on by** `bridge`, `hub` (the wire) and `app` (the snapshot only).

**Must not know** SQLite, React, the filesystem, or `node:crypto` beyond what `identity`
hands it. It is shapes and their validation, nothing that performs I/O.

The split matters more than it looks. One package holding two contracts under one name is how
the app ends up depending on the hub's wire by accident: change a frame for the hub's benefit
and the browser follows silently. With two doors, that becomes a compile error. See
[the app's door](#the-apps-door) below.

It is also load-bearing rather than decorative. While the two contracts shared a module, every
page load shipped zod's entire runtime to deliver eleven integers — 87 kB of parser, 24 kB
gzipped, for a wire the browser never touches. Separating them dropped the app's main bundle
from 354 kB to 266 kB without removing a feature. A boundary that costs nothing to cross is
one nobody notices crossing.

## `@quartet/tunnel`

**Owns** getting a public URL for a port on loopback — the hub, so somebody can be invited to
it; the bridge, so a paired phone can reach the app.

**Exports** one function, `startTunnel(port)`.

**Depended on by** `bridge`, `hub` — one call site each.

**Must not know** anything about quartet. It takes a number and returns a URL or a reason it
could not.

**It is not a transport layer, and should not be described as one.** The bridge↔hub socket is
a plain WebSocket that does not route through it, and quartet works with no tunnel at all when
both machines can already reach the hub. It is a `cloudflared` wrapper with a retry: sixty-odd
lines that exist because Cloudflare ships no pure-JS client, so "no install step" means
fetching the Go binary ourselves. Naming it a layer would promise a seam that is not there.

## `@quartet/theme`

**Owns** the palette and the type stacks. Twelve colours, three font stacks, one favicon.

**Exports** `./tokens.css` and `./favicon.svg`.

**Depended on by** `app`, `website`.

**Must not know** any component, any layout, any framework.

**Tokens only, and staying that way.** There is not a single selector in it outside `:root`.
The 764 lines of app styling live in `packages/app`, the 128 lines of site styling live in
`packages/website`, and neither is trying to migrate here. What is shared is the vocabulary —
so that a colour changed once changes the product and the page that sells it together, and the
two cannot drift into looking like two companies.

Growing this into a component library would mean the app and the marketing site want the same
components, and they do not: one renders a live conversation, the other renders a pitch.

## `@quartet/hub`

**Owns** the meeting point. A socket router with SQLite: handles and their keys, connections,
rooms, invites, turn policy, presence, rate limits, backpressure.

**Exports** nothing. It is a process, started by `bun run hub`.

**Depended on by** nothing.

**Must not know** a model key, a plaintext line, or what anything cost. Every token quartet
spends is spent on a participant's own machine with their own key, which is what makes a
public instance survivable — flat hosting cost, no free-inference abuse vector. Rooms are
sealed from it by design, so it relays what it cannot read, and the ledger of what an agent
said lives on that agent's own bridge.

If this package ever needs to decrypt something to do its job, the confidentiality design has
been broken rather than extended. See [confidentiality](confidentiality.md).

## `@quartet/bridge`

**Owns** your half. One outbound socket to a hub, jazz over loopback, your keys, your ledger,
your journal, the device pairing, and it serves the app.

**Exports** a `quartet` binary. Its modules are internal — no other package imports them.

**Depended on by** nothing.

**Must not know** the browser's rendering concerns. It publishes a snapshot; how that becomes
a screen is the app's problem.

Nothing inbound: no port to forward, no filesystem-capable agent exposed. That property is
load-bearing, and any change that opens a listening socket to the world is a change to the
threat model, not a feature.

## `@quartet/app`

**Owns** the app you look at. One socket to your own bridge, whole-snapshot rendering, and
every form.

**Exports** nothing. Vite builds it; the bridge serves the build.

**Depended on by** nothing.

**Must not know** that a hub exists.<a id="the-apps-door"></a> This is the sharpest of the
"must not know" rules and the easiest to erode. The page talks to *your bridge*, which means
the surface reading your ledger is same-origin with the process holding it, and "a public page
reaching into a private network" never has to exist.

Concretely: `app` imports `@quartet/protocol/app`, never `@quartet/protocol`. Hub frames,
zod schemas and signature verification are not the browser's business — and the app entry
point is what makes that a compile error instead of a code review note.

## `@quartet/website`

**Owns** the marketing and docs site. Astro, with the docs rendered from `docs/`.

**Exports** nothing.

**Depended on by** nothing.

**Must not know** the protocol. It shares the palette and it reads the same markdown a reader
would; it has no opinion about frames. It is excluded from the root `tsconfig` because
`astro:content` is a virtual module that only exists under `astro check`.
