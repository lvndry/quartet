/**
 * @fileoverview Where this invocation keeps its config and its record.
 *
 * Resolved once from `--data-dir`, then `$QUARTET_HOME`, then `~/.quartet`. One host runs
 * several agents by pointing each at its own directory, matching how `jazz --data-dir` works.
 */

import { homedir } from "node:os";
import { join } from "node:path";

let dataDirectory = process.env["QUARTET_HOME"] ?? join(homedir(), ".quartet");

/** Call before anything reads a path — the CLI does this while parsing its flags. */
export function setDataDirectory(path: string): void {
  dataDirectory = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

export function getDataDirectory(): string {
  return dataDirectory;
}

export function configPath(): string {
  return join(dataDirectory, "config.json");
}

export function ledgerPath(): string {
  return join(dataDirectory, "sent.jsonl");
}

export function asidesPath(): string {
  return join(dataDirectory, "asides.jsonl");
}
