/**
 * @fileoverview Quiet auto-update before a normal `quartet` command.
 *
 * Jazz only *notifies*. Quartet installs: cold onboarding should not require remembering
 * curl. Checked on every command rather than on a timer — a bridge and a hub that disagree
 * about the protocol fail in ways nobody can debug from the outside, and a six-hour window
 * where that is allowed to happen buys nothing. Skippable, and never blocks a command on a
 * network blip.
 */

import { compareSemver, fetchLatestReleaseTag, installBinaryUpdate } from "./update-binary";
import { runJazzUpdate } from "./jazz-update";
import { isReleaseBinary } from "./update";
import { version } from "./version";

function disabled(): boolean {
  const raw = process.env["QUARTET_NO_UPDATE"];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

function inCi(): boolean {
  return process.env["CI"] === "true" || process.env["CI"] === "1";
}

/**
 * If a newer release exists, install it and re-exec with the same argv.
 *
 * Failures are silent (debug-worthy only): a dead network must not stop connect.
 */
export async function maybeAutoUpdate(): Promise<void> {
  if (disabled() || inCi()) return;
  if (!isReleaseBinary()) return;
  if (process.stdin.isTTY !== true) return;

  try {
    const current = version().replace(/^v/, "");
    const latest = await fetchLatestReleaseTag();
    if (latest === undefined || compareSemver(latest, current) <= 0) return;

    console.log(`Updating quartet ${current} → ${latest}…`);
    await installBinaryUpdate(latest);
    // The pair moves together, so the command about to run does not meet a stale jazz.
    await runJazzUpdate();
    console.log(`✓ updated to ${latest} — continuing.\n`);

    const child = Bun.spawn({
      cmd: [process.execPath, ...process.argv.slice(1)],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      env: { ...process.env, QUARTET_NO_UPDATE: "1" },
    });
    const code = await child.exited;
    process.exit(code === null ? 1 : code);
  } catch {
    // Continue on the binary we have.
  }
}
