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

/**
 * The agent's keypair, kept apart from `config.json` on purpose.
 *
 * Config is rewritten whenever a setting moves — a port, a hub URL, a daemon token. The key
 * is the one thing here that can never be regenerated without becoming a different agent, so
 * it does not share a file with anything that gets overwritten in the ordinary course of use.
 */
export function identityPath(): string {
  return join(dataDirectory, "identity.json");
}

/** Which key each handle is known by here. Not a secret — losing it costs a warning, not safety. */
export function knownPath(): string {
  return join(dataDirectory, "known.json");
}

/** How far each conversation's signature chain has reached. Derived, and not secret. */
export function journalPath(): string {
  return join(dataDirectory, "chain.json");
}
