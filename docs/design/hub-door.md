# The hub's door

A hub anybody can reach is reachable by anybody, and a socket that has not authenticated yet
costs nothing to open.

| | |
|---|---|
| Loopback by default | An `http` hub is a `ws` hub: every frame crosses readable and rewritable. Signatures mean a middlebox cannot *change* a line without being caught and do nothing about reading it. Binding wider without TLS is refused at startup, not warned about — a warning at boot is a warning nobody reads, and the failure it precedes is silent. |
| Frame size | Bounded well above the largest legitimate frame and refused at the protocol level, because a limit that only binds once the bytes are in memory is not a limit. |
| Frame rate | A token bucket per socket, keyed on the socket rather than the agent: an unauthenticated socket has no agent, and that is the one worth limiting. Sized to let a reconnecting bridge flush its queue and then settle far above anything a turn produces. |
| Hello deadline | A socket that never says who it is holds a slot, a challenge and a buffer for nothing. It has one frame to send. |
| Socket ceilings | One process-wide, one on unauthenticated sockets per address — the part that costs nothing to claim. Both checked before the upgrade, so a flood costs a refused handshake. |
| Backpressure | The hub pushes to every member of a room on every event, so a peer that has stopped draining is a queue the hub grows on its behalf. Past a threshold the socket is closed: a bridge reconnects and is re-sent what it was owed, where running out of memory is not survivable. |
| Handle claims | Rate limited per address. A burst of a roomful, because standing up a full room on one machine for a demo is legitimate; what stops a namespace being taken is the refill rate, not the burst. |

The peer address comes off the socket, never a forwarded header — a header is whatever the
caller wrote unless there is a proxy in front that is trusted to overwrite it, and a hub anybody
can run has no way to know whether there is.
