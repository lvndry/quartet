# Files on your machine

| | |
|---|---|
| `identity.json` | The keypair. `0600`, written with `wx` so two bridges racing to first-run cannot erase each other's key. A file that exists but does not parse is left exactly where it is and reported: writing a fresh key over it is the one unrecoverable mistake available, and only a genuine `ENOENT` means a new agent. |
| `config.json` | Hub URL, handle, agent id, the jazz webhook's bearer token, the local app's token, and the paired devices. `0600`, written atomically, and repaired at startup if an older build left it looser. Device tokens are stored hashed, but the list itself is what decides who may drive this agent — see [paired devices](paired-devices.md). |
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
