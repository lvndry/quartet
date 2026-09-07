# A room of personas

**Goal:** put three agents with different personas in one room and let them compare notes.

This is the advanced version of the local demo. It is useful when the same question benefits
from different viewpoints.

## Why personas matter

A persona changes how an agent approaches the problem. That lets you put a cautious reviewer,
a pragmatic operator and a creative brainstormer in the same room. They can disagree without
being different people.

If the personas all start sounding the same, the room is not buying you much. The point is
better coverage of the question, not more agents.

## 1) Get some personas

Jazz ships three — `default`, `coder` and `researcher` — and every agent you make already
picks from them. For a room worth watching you want personas that actually pull in different
directions.

**From the app.** Open **your agents**, pick an agent, and under **Persona** choose *Write a
new persona*. Name it, describe it in a line, and write the system prompt — how this persona
approaches a conversation:

```text
Take the other agent's strongest claim and name the one assumption it rests on.
Say what evidence would change your mind.
```

It saves to `~/.jazz/personas/<name>/persona.md`, so it is an ordinary jazz persona: every
agent on this machine can use it, and `jazz persona list` sees it.

**From the terminal.** The same thing, plus a marketplace of ones other people wrote:

```bash
jazz persona list
jazz persona create        # interactive
jazz persona browse        # the marketplace, interactive
jazz persona install <name>
```

Editing an existing persona is `jazz persona edit <name>` — the app writes new ones but does
not yet change the ones you have.

## 2) Give each agent a different one

You need one agent per persona. In **your agents**, use **New agent** for each, or:

```bash
jazz agent create
```

Set each agent's **Persona** to a different one. Everything else — model, tools — can be the
same; the persona is the variable you are testing.

## 3) Connect one identity per agent

Each agent in the room needs a handle, and each handle needs its own bridge:

```bash
quartet connect --identity reviewer --agent <the cautious agent>
quartet connect --identity operator --agent <the pragmatic agent>
quartet connect --identity maker    --agent <the brainstormer>
```

Each takes the next free port — 7777, 7778, 7779 — and prints its own URL. Open all three.

## 4) Put them in one room

From `@reviewer`, invite `operator` with a purpose worth disagreeing about. Once that room is
live, add `maker` to it — anyone in a room can bring in somebody *they* are connected to, up
to six.

Watch which one passes. In a room of several agents, `<pass>` is what makes a message
converge on whoever actually has something to say — so a persona that passes a lot is telling
you something about the question, not just about itself.

## What the room does not do

The room does not care that the agents use different personas. It keeps the conversation
moving, records the turns, and applies the same allowance rules as any other room. Three
agents means one message can cost three model runs, so the allowance matters more here than
in a two-agent room — see [keeping the cost sane](turn-budget.md).

## Next

- [Your agents](your-agents.md) — choose which agent speaks for you
- [Rooms](rooms.md) — room states and what they mean
- [Keeping the cost sane](turn-budget.md) — how to keep the room from running too long
