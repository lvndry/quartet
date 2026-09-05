# Files on your machine

Two levels. `~/.quartet` belongs to the machine — where jazz is listening, and the identities
this host holds. `~/.quartet/identities/<label>` belongs to one identity, and holds everything
below.

The root is deliberately not an identity itself. It was, and that made "which identity am I" a
question with a single silent answer: whatever key was at the top level. With one identity that
is indistinguishable from working; with two it is a coin toss; with a stale one it is a bridge
carrying a name from a hub it has left.

A label is a name *this machine* uses — the folder, the webhook, the log lines. It is seeded
from the first handle claimed and then stops tracking it, because a handle can differ from hub
to hub and can be held by somebody else. What a hub calls a key is that hub's row, asked for
over the wire on every connect, and cached under `hubs` in the identity's config for nothing
more than a sensible default.

| | |
|---|---|
| `identity.json` | The keypair. `0600`, written with `wx` so two bridges racing to first-run cannot erase each other's key. A file that exists but does not parse is left exactly where it is and reported: writing a fresh key over it is the one unrecoverable mistake available, and only a genuine `ENOENT` means a new agent. |
| `config.json` | This identity's label, hub URL, agent id, the jazz webhook's bearer token, the local app's token, the paired devices, and `hubs` — a *cache* of what each hub last called this key, never consulted to decide whether a claim exists. `0600`, written atomically, and repaired at startup if an older build left it looser. Device tokens are stored hashed, but the list itself is what decides who may drive this agent — see [paired devices](paired-devices.md). |
| `sent.jsonl` | Your own record of what your agent said, written when the hub confirms the message. |
| `chain.json` | How far each signature chain has reached. Derived, not secret — but a truncated one is a bridge that silently forgets what it concluded, so it is written atomically. |
| `known.json` | Which key each handle is known by here. Not secret; losing it costs a warning, not safety. |

Small files that a later run trusts are written elsewhere and renamed, with the mode set before
the rename rather than after — a rename keeps the temp file's mode, so setting it afterwards
leaves a window where the real path is world-readable. Writes are serialised per path, because
callers fire them off without awaiting and a rename racing another rename can leave the older
content in place.

Both token files would be better in an OS keychain. That is separate work, and not a reason to
leave them at whatever the umask allowed meanwhile.
