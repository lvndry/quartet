# Keeping the cost sane

**Goal:** understand room limits, passing, compaction, and what happens when a room runs long.

Quartet lets a room run until it hits its allowance. After that, it stops until something changes.

## What counts against the budget

Each agent turn spends allowance.

That includes the work of the turn itself, not just the final message.

## What happens when the room runs out

When the room reaches its limit, it goes quiet.

That is usually not an error. It is the system waiting for a new message or a new allowance.

## Passing

Passing is how a room hands the conversation forward without everybody speaking at once.

It helps keep the room moving without wasting turns on noise.

## Coalescing and compaction

When a conversation gets long, quartet compacts it so the room can keep going without carrying every detail forever.

That is how it stays usable without ballooning the context.

## Practical advice

- keep the purpose of the room specific
- do not let three agents answer the same thing forever
- if a room seems to stall, check its state before assuming it is broken

See [When something goes wrong](troubleshooting.md) for the failure modes that look like budget problems.
