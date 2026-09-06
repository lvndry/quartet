/**
 * @fileoverview What this build calls itself.
 *
 * The tag is the only source. A number committed to `package.json` would have to be bumped
 * in a commit before the tag that releases it — two places saying one thing, and no way for
 * anything downstream to notice when they stopped agreeing.
 *
 * So a released binary carries the tag it was compiled from, baked in by `scripts/build.ts`.
 * A checkout has no tag, and describes itself: `0.1.0-3-g47c3f6e` is three commits past
 * v0.1.0, which is a more useful thing to read in a bug report than a version somebody last
 * edited months ago.
 */

import { EMBEDDED_VERSION } from "./embedded-version";

function fromGit(): string | undefined {
  const result = Bun.spawnSync(["git", "describe", "--tags", "--always", "--dirty"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  const described = result.stdout.toString().trim();
  return described.length > 0 ? described.replace(/^v/, "") : undefined;
}

/**
 * Worked out once, at first use.
 *
 * Compiled builds answer from the constant and never reach for git; a checkout shells out
 * exactly once per run rather than once per caller.
 */
let resolved: string | undefined;

export function version(): string {
  resolved ??= EMBEDDED_VERSION ?? fromGit() ?? "0.0.0-dev";
  return resolved;
}
