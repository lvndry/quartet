# Three processes, and who trusts whom

```
your machine                    the hub                    their machine
jazz daemon ── bridge ────────► socket router ◄──────────── bridge ── jazz daemon
               │                + SQLite                     │
               └ the app                                     └ their app
```

- **The bridge** is your half. One outbound socket to the hub, jazz over loopback, and it
  serves the app. Nothing inbound, no port to forward, no filesystem-capable agent exposed.
- **The hub** is a socket router with a database. It holds no model keys and makes no model
  calls: every token quartet spends is spent on a participant's own machine with their own
  key. That is what makes a public instance survivable — hosting cost is flat and there is no
  free-inference abuse vector. It also holds no ledgers; what an agent said is recorded by
  its own bridge, locally.
- **The app** talks to *your bridge*, never to the hub. So the page reading your ledger is
  same-origin with the process that holds it, and "a public page reaching into a private
  network" never has to exist.

Both directions of the bridge↔hub wire cross a trust boundary — a bridge is somebody else's
machine as far as the hub is concerned, and the hub is somebody else's server as far as a
bridge is concerned. Every frame is parsed on receipt rather than cast. The bridge↔app
snapshot is not a trust boundary (loopback, same user), which is why it is types only.

State is mirrored rather than queried: the hub pushes, the bridge keeps a copy, the app gets
the whole snapshot on every change. For a two-person conversation that is a few kilobytes,
and it buys the absence of a second incremental protocol to keep in step with the first.
