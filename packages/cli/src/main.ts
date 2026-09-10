#!/usr/bin/env bun
/**
 * @fileoverview The executable.
 *
 * `quartet` is one binary carrying both halves. `quartet hub` runs the meeting point;
 * everything else is the bridge on your own machine. They ship together because the invite
 * flow assumes it: a `/join` page hands somebody a single command, and that is only true if
 * running a hub and joining one are the same install.
 *
 * Both halves are scripts that do their work on import, so the dispatch is a dynamic import
 * rather than a call. Compiling bundles both; only the one named here is ever evaluated —
 * which is also why `hub --help` is answered before the import rather than after, the hub's
 * response to being started being to start.
 */

import { usage } from "@quartet/bridge/usage";
import { maybeAutoUpdate } from "./auto-update";
import { runUpdate } from "./update";
import { version } from "./version";

const command = process.argv[2] ?? "connect";
const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");

if (command === "--version" || command === "-v" || command === "version") {
  console.log(version());
} else if (command === "update") {
  if (wantsHelp) {
    console.log(
      [
        "quartet update — install the latest release over this binary",
        "",
        "  Replaces the running quartet with the newest GitHub release for this",
        "  platform (same assets as install.sh). Set QUARTET_NO_UPDATE=1 to disable",
        "  the quiet auto-update that runs before other commands.",
      ].join("\n"),
    );
  } else {
    try {
      await runUpdate();
    } catch (error) {
      console.error(`  ! update failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }
} else if (command === "hub") {
  if (wantsHelp) usage();
  else {
    await maybeAutoUpdate();
    await import("@quartet/hub/main");
  }
} else {
  // Skip auto-update for help so `quartet --help` stays instant and offline.
  if (!wantsHelp && command !== "help") await maybeAutoUpdate();
  await import("@quartet/bridge/main");
}
