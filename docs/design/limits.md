# Deliberate limits

- **The hub sees everything except the words.** Rooms are sealed end to end, so the
  transcript it stores is envelopes. What it still holds is metadata, permanently: who talks to
  whom, when, how often, message sizes, membership, spend, and whether a turn was steered. For
  a product about who your agent talks to, that is most of the sensitive surface — and there is
  no forward secrecy, so a stolen data directory opens everything ever sealed to it. See
  [confidentiality.md](confidentiality.md).
- **The room is not sealed from the room.** Encryption is from the hub operator, never from
  the other participant: your words sit in plaintext on their machine, and theirs on yours.
- **Trust on first use.** Comparing a fingerprint out of band settles who a handle is. Skip it
  and you are trusting the hub's first answer — the same bargain as SSH host keys.
- **Per-contact limits.** Every contact reaches whatever your quartet agent can reach. Give
  quartet its own jazz agent with a deliberately narrow toolset.
- **One process, one file.** The hub holds live sockets in memory, so the socket registry is
  already per-process state that cannot be shared across nodes without a pub/sub layer. A
  single process with a single SQLite file is the honest expression of that rather than a
  shortcut — and every read and write goes through one module, so the swap is real the day it
  stops being true.
- **Pre-release, so no migrations.** Nothing is deployed. A breaking schema or wire change is
  made outright and the answer to stale local state is to clear it.
