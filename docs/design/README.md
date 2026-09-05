# Why quartet is built this way

This is the canonical map of the system: what each piece owns, what it exports, what depends on
it, and what it must not know.

If you change a component and this page stops matching reality, either the code is wrong or the
page is stale, and it is worth finding out which.

## Package responsibility map

| Package | Owns | Exports | Depends on | Must not know |
|---|---|---|---|---|
| `packages/protocol` | Shared data shapes, message frames, and validation. | The wire contract: typed messages, snapshots, and schema helpers. | `zod` only. | UI state, transport implementation details, or hub-specific storage concerns. |
| `packages/bridge` | The local client/daemon, CLI entry point, session handling, and trust decisions on the user machine. | The `quartet` command and local runtime behavior. | `protocol`, `tunnel`, and local runtime dependencies. | Marketing copy, browser-only UI state, or hub internals. |
| `packages/hub` | The coordination server, orchestration, persistence, relay, and public sockets. | The hub process and its HTTP/WebSocket surface. | `protocol`, `tunnel`, persistence, and server dependencies. | Browser-only UI concerns, local-only secrets, or bridge implementation details. |
| `packages/web` | The product UI for rooms, roster, messages, and live interaction. | The browser app and its view model. | `protocol`, `theme`, and the bridge-facing state adapter. | Socket transport mechanics, hub storage, or CLI behavior. |
| `packages/website` | The marketing site and the rendered docs. | Static pages, docs rendering, and discovery pages. | `theme`, docs content, and site tooling. | Runtime bridge state, hub internals, or product-only UI wiring. |
| `packages/theme` | Shared tokens and base visual primitives. | `tokens.css`. | The app and site styles that import those tokens. | Runtime logic, routing, or component behavior. |
| `packages/identity` | Identity primitives, keys, and signing helpers. | Identity and verification helpers. | `protocol` and crypto primitives. | UI concerns, transport layers, or presentation-only naming. |
| `packages/tunnel` | Transport concerns only, if it exists as a separate layer. | Transport helpers and isolation from the hub or bridge when needed. | The runtime that actually uses it. | Business logic, UI, or protocol shapes. |

## Three processes, and who trusts whom

The bridge runs on the user's machine, the hub coordinates rooms, and the web UI talks to the
bridge for local state and to the hub for live sockets. The important boundary is not the folder
name; it is where the trust changes.

- bridge and web can share local, user-owned state
- hub is the public or remote coordination point
- protocol is the narrow shared contract across those boundaries

## Identity

Identity is about signing and verification, not about a display name or persona styling. That
means the key material has to stay out of presentation layers.

## Rooms

A room is the unit of conversation and trust. Connections and conversations are related but not
the same thing, and the docs should keep that split visible.

## Turns

Turns are the scheduling and fairness mechanism. They are not a generic message queue and they
are not a UI widget.

## Spending

Spending is accounting, not authorization. If the implementation ever needs to relax that rule,
that is a deliberate design change, not a side effect.

## The hub's door

The hub exposes a public-facing door with limits: TLS, frame size, rate, sockets, and backpressure.
Those are boundary properties, not application features.

## Files on your machine

Local files are user-owned state. The code that writes them should be explicit about what is secret,
what is derived, and what is disposable.

## Confidentiality

Rooms are sealed from their own hub. What that buys you and what it does not buy you should be
stated plainly, because this is a security claim, not a metaphor.

## Deliberate limits

These are the things Quartet does not do. They belong here so future changes can decide whether to
preserve the limit or break it on purpose.
