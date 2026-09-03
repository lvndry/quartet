# Hosted tunnel: `*.quartet.life` for everyone, by default

**Status: spec only, not built.** This is a real infrastructure commitment, not a code
change — read the "What this actually commits you to" section before starting on it.

## Goal

Today, `bun run hub --tunnel` gets a random, anonymous Cloudflare quick-tunnel URL
(`tracker-criticism-enquiries-dts.trycloudflare.com`) — free, no account, no setup, but
unmemorable and not on a domain anyone recognizes as quartet's.

This spec is for making `--tunnel` hand out a `*.quartet.life` subdomain instead, for
**every** user of the project by default (confirmed: default, not opt-in), by running a
service that holds a Cloudflare API credential on the domain owner's behalf.

## Why this is a different category from everything else built so far

The hub's own design principle, stated in its own file header
(`packages/hub/src/main.ts:1-9`): "It holds no model keys and makes no model calls...
hosting cost is flat, and there is no free-inference abuse vector to defend." This spec
breaks that principle on purpose — it adds a real credential, a real service, and a real
abuse surface. Worth restating plainly:

- **It's a public, unauthenticated endpoint minting subdomains on your domain**, callable
  by anyone who runs `bun run hub --tunnel` — including strangers with no relationship to
  the domain owner. Whatever they host through it (a phishing page, malware, spam) sits
  on your domain's reputation and your Cloudflare account.
- **It's a required dependency.** Right now `--tunnel` needs nothing of the domain
  owner's — Cloudflare's own anonymous network does the whole job. This adds a service
  every `--tunnel` user now depends on being up.
- **It has real ongoing cost**: not Cloudflare's tunnel/DNS pricing (free at hobby
  scale), but hosting the provisioning service itself, plus the ongoing time cost of
  abuse monitoring and takedowns.

None of that rules it out — this is roughly the shape of what ngrok's paid custom-domain
tier does. It means going in with the scope decided, not discovered later.

## Architecture

### 1. Provisioning service (new — hosted by the domain owner)

A small API, e.g. `https://provision.quartet.life`, holding a **scoped** Cloudflare API
token server-side only (Zone.DNS edit + Cloudflare Tunnel edit for the `quartet.life`
zone specifically — not a full-account token). Never distributed to clients, never in
this repo.

`POST /tunnels` — called by a hub on `--tunnel` startup. No auth (per the "default for
everyone" decision), rate-limited by source IP.

Response: `{ subdomain: "x7f2.quartet.life", connectorToken: "<cloudflared token>" }`

Behind that response, the service:
- Creates a new Cloudflare named tunnel via the Cloudflare API.
- Routes a fresh, randomly-generated subdomain (opaque, like the hub's existing
  `newNonce()`-style identifiers — not user-chosen, to avoid squatting on clean names)
  to that tunnel.
- Issues a connector token scoped to *that one tunnel only* and returns it. The domain
  owner's root credential never leaves the provisioning server.

`DELETE /tunnels/:subdomain` — tears the tunnel and DNS route down. Called when the hub
shuts down cleanly (`SIGINT`/`SIGTERM`, already handled in `packages/hub/src/main.ts`).
Also needs a periodic reaper for orphaned tunnels left behind by an unclean exit (a TTL:
delete anything with no connector heartbeat for, say, 15 minutes).

Also needed, day one, not later: an **admin takedown path** — a way to immediately kill
a specific subdomain regardless of what the reaper would otherwise do, for when content
abuse is reported (not something rate-limiting touches at all), plus a visible abuse
contact, since a live domain proxying arbitrary tunneled traffic needs one.

### 2. Hub-side integration (`packages/hub/src/tunnel.ts`)

A new `startHostedTunnel(port)`, parallel to today's `startTunnel(port)`:
- Calls the provisioning API.
- On success, runs `cloudflared` with the returned connector token
  (`cloudflared tunnel run --token <token>`, or the npm package's token-based API if it
  exposes one — needs checking against today's `Tunnel.quick()` usage).
- **On any failure — unreachable, malformed response, timeout — falls back to today's
  anonymous `Tunnel.quick()` path**, not a hard error. This is the load-bearing
  reliability property of choosing "default for everyone": the shared service being
  down must never mean `--tunnel` stops working, only that it falls back to what it
  does today.
- `--tunnel` stays one flag; internally it now means "try the hosted service, fall back
  to anonymous." An escape hatch (e.g. `--tunnel=anonymous`) should exist for anyone who
  doesn't want a quartet.life subdomain at all — someone privacy-conscious, or who
  doesn't want to depend on a third party they didn't choose.

### 3. Abuse control — rate-limit by IP only (confirmed starting point)

Reuse the existing `RateLimiter` (`packages/hub/src/rate-limit.ts`), the same pattern
already used for handle registration — "a roomful at once, then one every twenty
minutes," per its own comment (`packages/hub/src/main.ts:119-124`). Same shape here:
one or two tunnels immediately, then a cooldown per IP.

**Explicitly accepted weakness for v1**: per-IP limiting does nothing against a
determined abuser rotating IPs or using a VPN. The documented upgrade path if that
becomes a real problem is requiring a lightweight account/token before provisioning —
real auth infrastructure, deliberately not built now.

## Non-goals for v1

- No persistent subdomain per person — every `--tunnel` run gets a fresh random one,
  same churn as today. "Reserve my subdomain" is a separate, later feature needing real
  accounts.
- No content inspection or moderation of tunneled traffic — matches Cloudflare's own
  quick-tunnel stance, but worth being explicit this isn't solved by rate-limiting.
- No uptime guarantee — this is a side-project service, not a company; document it as
  best-effort.

## Open risks to resolve before building, not after

- **Legal/ToS exposure**: proxying arbitrary traffic under your own domain likely needs
  a written acceptable-use policy, and puts the domain owner as the responsible party of
  record with the registrar and with Cloudflare.
- **Silent-failure handling**: the fallback-to-anonymous path needs to trigger on
  *every* way the provisioning service can misbehave, not just a clean network error —
  a malformed response or a slow timeout must fall back too, not hang or error the
  whole `--tunnel` flow.
- **No way to act on a specific abuser long-term** — IP-only rate limiting with no
  accounts means there's no way to block a *person*, only whatever IP they currently
  have.

## Build order, if this goes ahead

1. Provisioning service (new, separate deploy — not part of this repo's packages).
2. `startHostedTunnel` in `packages/hub/src/tunnel.ts`, with the fallback path as the
   first thing tested, not the last.
3. Admin takedown path and abuse contact, before this is announced to anyone beyond
   testing.
4. `--tunnel=anonymous` escape hatch.
