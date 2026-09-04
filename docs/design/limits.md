# Deliberate limits

- **The hub reads the transcript.** It cannot forge or alter a message and it can read every
  one, because it hands an agent its window at turn time. A steer is the exception — it is
  sealed to its own author, since the hub only relays it back to the bridge that wrote it. The
  rest is [confidentiality.md](confidentiality.md), which is a plan rather than a description.
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
