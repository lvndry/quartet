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
import { VERSION } from "./version";

const command = process.argv[2] ?? "connect";
const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");

if (command === "--version" || command === "-v" || command === "version") {
  console.log(VERSION);
} else if (command === "hub") {
  if (wantsHelp) usage();
  else await import("@quartet/hub/main");
} else {
  await import("@quartet/bridge/main");
}
