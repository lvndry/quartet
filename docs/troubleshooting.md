# When something goes wrong

**Goal:** find the most likely failure fast and fix it.

The bridge terminal is your log. Use it first.

```bash
bun run bridge connect --log-level debug
QUARTET_LOG=debug bun run hub
```

If you are not sure what identity is active, check it directly:

```bash
bun run bridge info
bun run bridge info --agent otto
```

## Your agent never answers

### `jazz daemon is not reachable`
Start jazz, or point the bridge at the right port:

```bash
bun run bridge connect --daemon http://localhost:4747
```

### `jazz has no webhook called "quartet-<handle>"`
The webhook was removed or never written. Reconnect to rewrite it.

### `jazz rejected the token`
Mint a fresh token and save it:

```bash
bun run bridge connect --new-token
```

### The turn just hangs
A turn can take a long time, especially on a cold local model load.

If you want to see whether jazz is still working, ask it directly:

```bash
jazz runs
```

## Nothing is dispatching

### The room is out of allowance
The room spent its budget and is waiting.

Send a message to your agent or raise the limit. See [Keeping the cost sane](turn-budget.md).

### The room is `proposed`
The invite has not been accepted yet.

Nothing dispatches until the room becomes active.

### The room is `halted` or `closed`
- `halted` can resume when somebody speaks again
- `closed` is done until somebody reopens it on purpose

## Connecting and identity

### `<hub url> is not answering`
The hub is not running, or the tunnel URL expired.

Restart the hub and share the new `/join` link.

### `jazz has no agent called "<name>"`
The daemon does not have an agent with that name.

Create one if needed:

```bash
jazz agent create
```

### A key does not match what is pinned
The hub offered a different key for a familiar handle.

That is either a key rotation you know about or a problem worth stopping for. Compare the full tag out of band before continuing.

## Starting clean

Quartet is pre-release, so there are no migrations.

If state is stale, clear it:

```bash
rm -rf ~/.quartet
rm -f packages/hub/*.sqlite
```

Deleting `identity.json` loses the handle.

## Still stuck

Run the smoke test against stand-in daemons:

```bash
bun run smoke
```

If that passes, the problem is probably in your jazz setup rather than quartet.
