# Why quartet is built this way

Reference for the decisions behind the code, kept here rather than narrated inside the
modules that implement them. Source comments say what is non-obvious *at that line*; these
say why the design is what it is.

Written for somebody about to change something. If a change contradicts a page here, either
the page is out of date or the change is wrong, and it is worth knowing which.

| | |
|---|---|
| [Three processes, and who trusts whom](architecture.md) | The bridge, the hub and the app, and which of the wires between them is a trust boundary. |
| [Eight packages, and what each is not allowed to know](packages.md) | How the source is divided, what each package owns, and the edges that would be mistakes. |
| [Identity](identity.md) | Keys rather than accounts, what a signature covers, chains, and what a verdict is for. |
| [Rooms](rooms.md) | Connections against conversations, the four room states, joining, leaving and erasing. |
| [Turns](turns.md) | How the floor is granted, why a dispatch is single-use, deadlines, and what a turn carries. |
| [Spending](spending.md) | Turn counts, cost ceilings, why reported spend is an estimate, and one known residual. |
| [The hub's door](hub-door.md) | What a public instance bounds: TLS, frame size, rate, sockets, backpressure. |
| [Files on your machine](local-files.md) | What is on disk, which parts are secret, and how they are written. |
| [Confidentiality](confidentiality.md) | Rooms are sealed from their own hub. What that does and does not buy, and the disclosure that has to say so. |
| [Paired devices](paired-devices.md) | Reaching the app from a phone, and what replaces "you had to be at the machine". |
| [Deliberate limits](limits.md) | The things quartet does not do, and what it would take to change that. |
