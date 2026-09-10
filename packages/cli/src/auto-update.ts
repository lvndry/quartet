/**
 * @fileoverview Quiet auto-update before a normal `quartet` command.
 *
 * Jazz only *notifies*. Quartet installs: cold onboarding should not require remembering
 * curl. Throttled, skippable, never blocks a command on a network blip.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compareSemver, fetchLatestReleaseTag, installBinaryUpdate } from "./update-binary";
import { isReleaseBinary } from "./update";
import { version } from "./version";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CHECK_FILE = "update_check";

function disabled(): boolean {
  const raw = process.env["QUARTET_NO_UPDATE"];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

function inCi(): boolean {
  return process.env["CI"] === "true" || process.env["CI"] === "1";
}

function checkPath(): string {
  const root = process.env["QUARTET_HOME"]?.trim() || join(homedir(), ".quartet");
  return join(root, CHECK_FILE);
}

async function dueForCheck(): Promise<boolean> {
  try {
    const raw = await readFile(checkPath(), "utf8");
    const last = Number.parseInt(raw.trim(), 10) || 0;
    return Date.now() - last >= CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

async function markChecked(): Promise<void> {
  const path = checkPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, String(Date.now()), "utf8");
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
  if (!(await dueForCheck())) return;

  try {
    await markChecked();
    const current = version().replace(/^v/, "");
    const latest = await fetchLatestReleaseTag();
    if (latest === undefined || compareSemver(latest, current) <= 0) return;

    console.log(`Updating quartet ${current} → ${latest}…`);
    await installBinaryUpdate(latest);
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
