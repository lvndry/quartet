/**
 * @fileoverview Keep jazz current whenever quartet updates itself.
 *
 * Quartet is only half the pair. A fresh bridge talking to a jazz that predates a route it
 * needs is the same outage as an old bridge, so the two move together. Jazz ships its own
 * installer — `jazz update` — and that is what runs here: picking release assets for somebody
 * else's project is how the two drift apart.
 *
 * Jazz not being installed is not a failure. Somebody can run `quartet hub` on a machine that
 * has no agents on it at all.
 */

/** What `jazz update` did, for a caller that wants to say so. */
export type JazzUpdateResult =
  | { readonly kind: "updated" }
  | { readonly kind: "failed"; readonly code: number }
  | { readonly kind: "absent" };

/** The jazz to update: the same `--jazz <path>` the bridge honours, else the one on PATH. */
export function resolveJazzCli(): string {
  const index = process.argv.indexOf("--jazz");
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : "jazz";
}

/**
 * Run `jazz update`, inheriting its output unless `quiet`.
 *
 * Never throws: quartet's own update stands whatever jazz does.
 */
export async function runJazzUpdate(options: { readonly quiet?: boolean } = {}): Promise<JazzUpdateResult> {
  const io = options.quiet === true ? "ignore" : "inherit";
  try {
    const child = Bun.spawn({
      cmd: [resolveJazzCli(), "update"],
      stdin: "ignore",
      stdout: io,
      stderr: io,
    });
    const code = await child.exited;
    return code === 0 ? { kind: "updated" } : { kind: "failed", code: code ?? 1 };
  } catch {
    // No jazz on PATH — nothing to keep in step.
    return { kind: "absent" };
  }
}
