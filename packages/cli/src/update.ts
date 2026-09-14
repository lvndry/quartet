/**
 * @fileoverview `quartet update` — install the latest GitHub release over this binary.
 */

import { EMBEDDED_VERSION } from "./embedded-version";
import { type JazzUpdateResult, runJazzUpdate } from "./jazz-update";
import {
  compareSemver,
  fetchLatestReleaseTag,
  installBinaryUpdate,
} from "./update-binary";
import { version } from "./version";

/** True when this process is a compiled release binary (not `bun` running a checkout). */
export function isReleaseBinary(): boolean {
  if (EMBEDDED_VERSION === undefined) return false;
  const exec = process.execPath;
  return !exec.endsWith("/bun") && !exec.endsWith("\\bun") && basenameLooksLikeQuartet(exec);
}

function basenameLooksLikeQuartet(exec: string): boolean {
  const base = exec.split(/[/\\]/).pop() ?? "";
  return base === "quartet" || base.startsWith("quartet");
}

/**
 * Update this binary, then jazz.
 *
 * Jazz runs whatever happened to quartet — including "already current", which says nothing
 * about the agent runtime underneath it. Somebody typing `update` means both halves.
 */
export async function runUpdate(options: { readonly quiet?: boolean } = {}): Promise<{
  readonly updated: boolean;
  readonly current: string;
  readonly latest?: string;
  readonly jazz: JazzUpdateResult;
}> {
  const quartet = await updateQuartet(options);
  if (!options.quiet) console.log("");
  const jazz = await runJazzUpdate(options);
  if (jazz.kind === "absent" && !options.quiet) {
    console.log("  · no jazz on PATH — nothing to update there.");
  }
  return { ...quartet, jazz };
}

async function updateQuartet(options: { readonly quiet?: boolean }): Promise<{
  readonly updated: boolean;
  readonly current: string;
  readonly latest?: string;
}> {
  const current = version().replace(/^v/, "");
  if (!isReleaseBinary()) {
    if (!options.quiet) {
      console.error(
        "  ! this is a checkout build, not a release binary.\n" +
          "    Install with:\n" +
          "      curl -fsSL https://github.com/lvndry/quartet/releases/latest/download/install.sh | bash\n",
      );
    }
    return { updated: false, current };
  }

  const latest = await fetchLatestReleaseTag();
  if (latest === undefined) {
    if (!options.quiet) console.error("  ! could not reach GitHub releases.\n");
    return { updated: false, current };
  }

  if (compareSemver(latest, current) <= 0) {
    if (!options.quiet) console.log(`Already on ${current}.`);
    return { updated: false, current, latest };
  }

  if (!options.quiet) console.log(`Updating quartet ${current} → ${latest}…`);
  await installBinaryUpdate(latest);
  if (!options.quiet) console.log(`✓ installed ${latest}`);
  return { updated: true, current, latest };
}
