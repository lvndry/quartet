# Your agents

**Goal:** choose which jazz agent speaks for you, and what it can reach.

Quartet does not use a settings page. It uses a roster: every jazz agent on this machine, with exactly one of them on stage.

Open it from the top bar: **your agents**.

## On stage

The agent marked *on stage* is the one that answers in every room.

When you switch agents, quartet rewrites the jazz webhook to point at the new one. The next turn comes from that agent instead.

This matters for security:
- that agent answers for you when you are not at the keyboard
- it can use whatever tools you have allowed it
- if it can read your filesystem, it may use that in its answers

There is no per-contact limit yet. Everyone talks to whatever the on-stage agent can reach, so keep a narrow agent on stage when you need a tighter boundary.

## Editing an agent

Click any agent to open it.

You can change:

| Field | What it controls |
|---|---|
| Name, Description | What the agent is called and how it is shown in the picker |
| Persona | The jazz persona it runs with |
| Provider, Model | Which model handles turns |
| Reasoning effort, Temperature | Extra model controls when available |
| Summarizer model | The cheaper model used for compaction |
| Context ceiling | Token limit for the conversation |
| Ollama `num_ctx` | Local-model context size when needed |
| Memory scopes | Which memories this agent may read |
| Env vars it may keep | Which environment variables it may keep around |
| Web search | Search provider, if any |
| Tools | Which tools are allowed |
| Companions | Per-modality model overrides |

The picker comes from jazz, not quartet. That keeps the UI aligned with what jazz will actually accept.

## Creating and deleting

Use **New agent** to make one from the same form.

Name is the only field quartet requires. Everything else is validated by jazz.

Deleting removes the agent from jazz. If you delete the current on-stage agent, put another one on stage before your next turn.

## Devices

Under the roster is **Devices** — anything other than this machine that can drive your agent.

A paired device can do everything this screen can, including changing which agent is on stage. Revoke anything you no longer trust.

## What this does not change

Editing an agent changes jazz's configuration on this machine. It does not change:

- your quartet identity
- your rooms or their history
- your local record in `sent.jsonl`

So switching the agent on stage is not a change of identity. To other people, you are still the same handle with the same key.

## Next

- [A room of personas](a-room-of-personas.md) — several agents, each with a different persona, in one room
- [Rooms](rooms.md) — what the agent on stage can do without you
