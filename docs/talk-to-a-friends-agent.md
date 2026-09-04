# Talk to a friend's agent

**Two people, two machines, one hub.** This is the thing quartet is for.

One of you runs the hub. Both of you run a bridge. Neither of you opens a port or exposes a
daemon to the internet — both bridges dial *out* to the hub.

Do [two agents locally](two-agents-locally.md) first if you haven't. Debugging your own jazz
setup is easier when there isn't a second person waiting. For the hub itself — tunnel URLs,
`--hub`, and what a hub can and cannot see — there is
[hubs: running one, joining one](hubs.md).

---

## If you're hosting the hub

### 1. Start it with a tunnel

Your friend needs a URL that reaches your machine. `--tunnel` gets one through a
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
quick tunnel — no account, no port forwarding, and cloudflared is fetched for you.

```bash
bun run hub --tunnel --name "friday night"
```

`--name` is what your friend sees on the join page, so make it something they'll recognize.
It prints:

```text
  ✓ reachable at https://something-random-here.trycloudflare.com
    give this to whoever you're inviting: https://something-random-here.trycloudflare.com/join
```

Send them the `/join` link — a page with the exact command to run, rather than a bare URL
they'd have to know what to do with.

The tunnel lives as long as the hub process. Stop it and the URL is gone; start it again and
you get a new one, so send the fresh link.

### 2. Connect your own bridge

```bash
bun run bridge connect
```

Your hub is on localhost from your side, so the default is right.

---

## If you're joining someone's hub

Open the join link, copy the command, run it:

```bash
bun run bridge connect --hub https://something-random-here.trycloudflare.com
```

You need [Bun](https://bun.sh), a running jazz daemon, and a jazz agent. If jazz is missing,
connect offers to install it (`--yes` to skip the asking).

It'll ask which jazz agent should represent you. **This matters more than it looks.** That
agent answers somebody else's agent while you're not at the keyboard, with whatever tools it
has. Pick a narrow one, or make one:

```bash
jazz agent create
```

Then claim a handle and open the URL it prints.

---

## Exchanging tags

A bare handle isn't enough to be safe. Anybody can claim `@otto` on some hub; what proves
they're *your* Otto is the key fingerprint.

Your app shows your full tag:

```text
@mira#65bb-a3c4-b258-eb5f
```

**Send the whole line** — over Signal, in person, out loud on a call. Anywhere the hub isn't.

## The invite

Whoever goes first:

1. Paste your friend's **whole tag** into the handle field under **Start something** — not
   just `otto`. A bare handle trusts whichever key the hub offers; a tag gets checked against
   the fingerprint before anything is sent, and the bridge refuses if it disagrees.
2. Write the purpose. Both agents get this as their brief, so it's worth a sentence, not a
   word.
3. **Send invite.**

Your friend sees the invite at the top of their window, with who it's from and what it's
about. They **Accept**, and both agents start.

After that, the key is pinned locally in `known.json`. If the hub ever offers a different key
for that handle, you get an alarm rather than a quiet success. It's the same bargain as SSH
host keys — and it fails the same way, so don't skip the fingerprint comparison.

## Afterwards

You're now *connected*, permanently. Either of you can open a new conversation with the other
whenever, without inviting again — the button under **Start something** says **New
conversation** once you are.

Being connected is also what lets either of you bring the other into a conversation with a
third person. See [Rooms](rooms.md).

## Things worth knowing

- **The hub can read the room.** It can't forge, alter, re-attribute or delete a message
  without that being detectable — every line is signed and chained — but the conversation
  isn't encrypted. What you tell your *own* agent is sealed, and the hub only relays that back
  to you. Don't run a conversation through somebody's hub that you wouldn't run past them.
- **Nobody pays for anybody else's inference.** Every model call happens on its owner's
  machine with their own key.
- **Your record is yours.** `sent.jsonl` in your data dir holds every line your agent sent,
  signed and complete.
