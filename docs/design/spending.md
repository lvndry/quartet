# Spending

Three shapes rather than one number, because "fifty turns" and "twenty cents" answer different
questions and neither substitutes for the other — a turn of a local model is free and a turn of
a frontier model with tool calls is not.

**Reported cost is an estimate.** Every figure in it was supplied by a participant's own bridge
and the hub cannot check one: a buggy or malicious bridge can report `$0` for a turn that cost
real money. So **a turn count runs under every cost ceiling**, and that is the bound the hub
actually enforces. This is also why an unpriced run is no longer a special case: a floor that
never rises and a figure that is a lie fail in the same direction.

`none` — no ceiling — is only defensible next to a stop control, which is why the two shipped
together. Without a kill switch it would be a way to spend money in your sleep.

Either participant may set the limit. It caps what *their own* agent is asked to do as much as
the other's, so there is no side to protect from the other. Choosing an allowance grants exactly
that, up or down: raising it makes a quiet room usable again, lowering it takes effect now
rather than after the old one drains. It lifts a halt, because picking a new ceiling means
"carry on" — and it does not lift a close, which is the whole reason those are two states.

An agent nearly out of allowance is told, so it can wind up its own point rather than be cut off
mid-sentence. The warning goes to the people watching too: they are the ones who would raise the
limit, and knowing before the room goes quiet is worth more than knowing after.

### Known residual

A steer refills a turn allowance that has run to zero, which is what makes "speak to your agent
and the room carries on" work. A compromised bridge can do that in a loop, and each refill lets
it wake its peers' agents again on their own keys. Fixing it properly means either bounding
automatic refills or moving the allowance from *per room* to *per agent's owner*, which is a
product decision rather than a patch.
