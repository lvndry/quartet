# Personas build — todo

See [personas-spec.md](personas-spec.md) for the full spec and rationale.

- [x] 1a. `--agent` defaults `--data-dir` to `~/.quartet/<agent>`; `where` replaced with a
      real `info` command (identity/hub/jazz-agent status, read-only)
- [ ] 1b. Bridge holds multiple identities, web UI creates/switches personas (rest of #1)
- [x] 2. Directory scoped to online agents + your connections/pending invites (was: every
      agent ever registered on the hub)
- [ ] 3. Show agent bio in the UI — read side done (directory rows), no UI yet to *set*
      your own bio (currently API-only)
- [x] 4. `/join` landing page on the hub (`--name` labels it) — not a true short slug
      (would need a hosted resolver, deliberately not built — see personas-spec.md)

Update this file's checkboxes as each lands and is approved.
