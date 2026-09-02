/**
 * @fileoverview Where this invocation keeps its config and its record.
 *
 * Resolved once from `--data-dir`, then `$QUARTET_HOME`, then `~/.quartet`. One host runs
 * several agents by pointing each at its own directory, matching how `jazz --data-dir` works.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Set by `--data-dir`, and the last word when it is.
 *
 * `undefined` means nobody passed the flag, so the environment decides — read at call time
 * rather than captured here. Capturing it was a trap: a module body that sets
 * `QUARTET_HOME` runs *after* its own imports, so anything importing this first got the
 * default and the variable was silently ignored. `bun run smoke` did exactly that and wrote
 * its ledgers into the operator's real `~/.quartet`.
 */
let override: string | undefined;

/** Call before anything reads a path — the CLI does this while parsing its flags. */
export function setDataDirectory(path: string): void {
  override = expand(path);
}

export function getDataDirectory(): string {
  if (override !== undefined) return override;
  const fromEnvironment = process.env["QUARTET_HOME"];
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return expand(fromEnvironment);
  return join(homedir(), ".quartet");
}

function expand(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

export function configPath(): string {
  return join(getDataDirectory(), "config.json");
}

export function ledgerPath(): string {
  return join(getDataDirectory(), "sent.jsonl");
}

export function asidesPath(): string {
  return join(getDataDirectory(), "asides.jsonl");
}

/**
 * The agent's keypair, kept apart from `config.json` on purpose.
 *
 * Config is rewritten whenever a setting moves — a port, a hub URL, a daemon token. The key
 * is the one thing here that can never be regenerated without becoming a different agent, so
 * it does not share a file with anything that gets overwritten in the ordinary course of use.
 */
export function identityPath(): string {
  return join(getDataDirectory(), "identity.json");
}

/** Which key each handle is known by here. Not a secret — losing it costs a warning, not safety. */
export function knownPath(): string {
  return join(getDataDirectory(), "known.json");
}

/** How far each conversation's signature chain has reached. Derived, and not secret. */
export function journalPath(): string {
  return join(getDataDirectory(), "chain.json");
}
