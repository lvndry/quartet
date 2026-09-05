# Paired devices: the app on a phone

**Status: built.** `bridge connect --expose`, `bridge pair`, and Your agents → Devices.

---

## Why

The app is served on loopback by the bridge, and that is not an accident — the local record
is trustworthy because the page reading it is same-origin with the process that wrote it.
But it means the only way to steer your agent is to be sitting at the machine, and steering
between turns is the whole interaction model. An agent that waits for you is much less
useful if you have to be at a desk to be waited for.

So: let a phone reach the app, without giving up the reason the app is local in the first
place.

## What actually changes

Today, reaching the app requires being on the machine. Afterwards, it requires holding a
credential. That single sentence is the entire security content of this document — every
decision below follows from it. Physical access is doing load-bearing work right now, and
pairing has to carry that weight instead.

The `?token=` in the startup URL is not that credential and was never meant to be. It is a
handoff between two processes on one machine, printed to a terminal you already control. A
URL that a phone might sync, log, or share is a different object.

---

## 1. Transport

**A paired device reaches the bridge through a cloudflare quick tunnel.** `startTunnel` in
`packages/hub/src/tunnel.ts` already does this for the hub, takes a port and nothing else,
and fetches `cloudflared` on first use. The bridge gets the same mechanism under a different
name: `--expose`.

Different because the two acts are not the same one. A hub is a meeting point, and making it
reachable is the whole of its purpose — `--tunnel` there names a piece of plumbing, which is
all it is. Your bridge is private by construction, and making it reachable puts your agent's
controls on the public internet. The flag should read like the decision it is, and one word
that names the consequence does more than a paragraph of documentation nobody opens.

TLS is not optional here, and not for the usual vague reasons. A steer is the one thing
quartet seals end to end: the hub relays it back to the bridge that wrote it and cannot read
it. Phone to bridge is a new hop carrying exactly that plaintext. Shipping it in the clear
would break the one confidentiality claim the product currently makes honestly.

### Why not a LAN address with a self-signed certificate

Because a browser cannot pin one. No public CA issues for `192.168.x.x`, so the phone shows
an interstitial on every visit, and the user learns to click through TLS warnings on the
device that now holds their agent's controls. A QR could carry a certificate fingerprint,
but no browser will consume it. The habit this trains is worse than the problem it solves.

It also fails the case that motivates the feature. "Check on my agent from my phone" mostly
happens away from the machine's network.

### Why not ask people for a certificate

Nobody should generate a certificate to read their own agent's messages. Cloudflare issues
and renews it; there is no per-user setup, no expiry to track, and no file to lose.
`QUARTET_TLS_CERT` stays available for anyone terminating TLS themselves, unchanged and
undocumented in the mobile path.

### The cost, stated plainly

A tunnel puts the agent's control surface on the public internet, reachable by anyone who
guesses the URL, gated by pairing alone. This is a real widening and the doc should not
pretend otherwise. It is accepted because the alternative that avoids it — cleartext on a
LAN — is worse in a way that is easy to miss, and because the tunnel URL dies with the
process.

**The bridge refuses to bind non-loopback without TLS**, in the same shape and for the same
reason as the hub already does at `packages/hub/src/main.ts:69`: a warning at boot is a
warning nobody reads, and the failure it precedes is silent.

---

## 2. Pairing

    bun run bridge pair

Prints a QR to the terminal encoding the tunnel URL and a one-time code. The phone scans it,
posts the code, and receives a device token.

| | |
|---|---|
| **Single use** | The code is spent on first redemption, whether or not it succeeded. |
| **Short TTL** | Two minutes. A pairing code lying around is a credential lying around. |
| **QR, not text** | A 32-character token typed on a phone is a token that gets pasted into a chat app to make it typable. |
| **Rate limited** | Redemption attempts are bounded, so a guessable code is not brute-forceable within its TTL. |

Pairing is initiated from the machine, never from the phone. There is no "request access"
flow, because approving one is a decision made under exactly the social pressure that makes
people approve things they should not.

`--expose` on a bridge with nothing paired prints the first code itself, because exposing the
app and then being told to run a second command to use it is a two-step for what is one
intention. On a bridge that already has devices it does not: a code nobody asked for is a
credential sitting on a screen.

**Exposure stays opt-in.** Not for the sake of a flag, but because the README's first
architectural claim is that quartet needs no inbound port and does not put a
filesystem-capable agent on the internet. Making `--expose` the default would make that claim
false for everybody who never asked for a phone, and would widen every future bug in the local
server from "reachable from this machine" to "reachable by anyone who finds the URL".

## 3. The credential

A per-device token in an `HttpOnly; Secure; SameSite=Strict` cookie. Not a query parameter:
a URL is copied, logged by intermediaries, synced across a browser profile, and rendered
into screenshots. A cookie with these flags is none of those things, and `HttpOnly` means a
script injected into the page cannot read it either.

Tokens are stored beside `localToken` in the data directory, which
`hardenSecretFiles` already covers.

## 4. Devices and revocation

A named list — device name, when it paired, when it was last seen — visible in the app and
revocable one at a time.

**Revocation drops live sockets.** Refusing new connections while an open WebSocket keeps
streaming the room is not revocation, and a lost phone is the case this feature exists for.
The device list is the mechanism that replaces "it was only reachable from this desk", so it
has to actually work on the timescale of realising a phone is gone.

## 5. What a paired device may do

**Everything the desktop app does**, including switching which agent is on stage.

This is a deliberate choice against a narrower one. Steer-only — rooms and allowances on the
phone, agent management left on the machine — would have kept the destructive surface
physically gated, and was rejected because a mobile app that cannot do the thing you opened
it to do sends you back to the desk anyway, which is the problem.

The consequence is worth writing down rather than discovering: switching the on-stage agent
rewrites the jazz webhook, so a paired phone can change which agent answers under your
handle. That makes §4 load-bearing rather than a convenience. A device list that is hard to
find, or revocation that only takes effect on reconnect, is a security bug under full
parity, not a rough edge.

## 6. One frontend, not a mobile one

**The same app, responsive.** No second frontend, no native shell, no cut-down mobile view.
A phone gets the rooms and the dashboard exactly as the desktop does, which is what §5
already committed to — a separate mobile build is how parity quietly becomes non-parity two
releases later, as each new control lands on one of them and not the other.

This is mostly already true. `packages/web/src/styles.css` carries breakpoints at 1280, 959
and 719 pixels: the nav becomes a drawer with a toggle and a scrim, the ledger moves from a
side column to a row beneath the chat, and the dashboard roster collapses to a single column.
`index.html` sets the viewport meta. The layout was built to fold.

What a handset adds on top of width is handled alongside those:

| | |
|---|---|
| **Real handset widths** | A `480px` block below the existing three. The topbar is what breaks first: with the model name dropped, the badge, the nav toggle and the connection status fit a 375px screen without clipping. |
| **Touch targets** | A `hover: none` block: controls get a 44px floor, and the model badge stops hiding its label behind `:hover` — on a device with no cursor that label was invisible rather than subtle, and it is the way into this screen. |
| **The on-screen keyboard** | `100dvh` behind an `@supports`, with `100%` as the fallback, and 16px inputs so iOS does not zoom the page on focus and leave it there. |
| **Safe areas** | `env(safe-area-inset-*)` on the topbar, the composer and the pairing screen. |

None of this is architectural. It is a pass over an existing stylesheet, and it is the
cheapest part of this document.

## 7. Origin

`originAllowed` in `packages/bridge/src/local.ts` currently hard-codes `localhost` and
`127.0.0.1` at the served port. It becomes "the origin this server is actually reachable on"
— loopback, plus the tunnel hostname when one is running.

The check itself stays exactly as important as it is today. It is what stops a site you
happen to be visiting from driving your agent, and widening the binding does not soften it.

---

## Interaction with confidentiality

`confidentiality.md` adds an X25519 keypair per identity and seals steers to it. A paired
device has to read and write those, and it does not hold the key.

**The bridge stays the only holder.** A phone sends a steer over TLS to the bridge, which
seals it; sealed traffic from the hub is opened by the bridge and served to the device over
TLS. The private key never leaves the machine, and a paired device is a view onto the
bridge rather than a second identity.

The alternative — giving each device its own keypair and making them all recipients — would
mean a revoked device that recorded ciphertext can still read it, and a key rotation on
every revocation. Not worth it for a view.

These two projects are independent, but this is the coupling. Whichever lands second should
re-read this section rather than assume.

---

## What this does not do

| | |
|---|---|
| **No hosted anything** | The tunnel points at your machine. There is still no quartet server holding your record. |
| **No stable URL** | A quick tunnel URL dies with the process, so a paired device re-pairs when the URL changes. Anyone wanting permanence terminates TLS themselves. |
| **No push notifications** | A phone that is not looking at the page learns nothing. Waking a device is a hosted service, and there isn't one. |
| **No second identity** | A paired phone acts as the machine's identity, not as one of its own. It signs nothing. |
