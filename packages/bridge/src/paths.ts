/**
 * @fileoverview Where this invocation keeps its config and its record.
 *
 * Two levels, because there are two kinds of fact here. `~/.quartet` belongs to the machine:
 * where jazz is listening, and the identities this host holds. `~/.quartet/identities/<label>`
 * belongs to one identity: its key, its record, its ports, its devices.
 *
 * The root is deliberately not an identity itself. It was, and that is what made "which
 * identity am I" an invisible question with a single silent answer — so a machine that had
 * only ever run one agent could not be told apart from one that had never been asked.
 *
 * A label is a name this machine uses, never a hub's. What a hub calls a key is a row in that
 * hub's database and is asked for over the wire; naming a directory after it would put a
 * second hub's word on this disk, which is the whole bug this layout exists to remove.
 */

import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Set by `--data-dir`, and the last word when it is.
 *
 * Read at call time rather than captured, because a module body that sets `QUARTET_HOME` runs
 * *after* its own imports: capturing it silently ignored the variable, and the smoke harness
 * wrote its ledgers into the operator's real `~/.quartet`.
 */
let identityOverride: string | undefined;

/** Which identity folder this run is working in, once something has chosen. */
let label: string | undefined;

/** The machine's directory: identities live under it, and it is not one itself. */
export function getRootDirectory(): string {
  const fromEnvironment = process.env["QUARTET_HOME"];
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return expand(fromEnvironment);
  return join(homedir(), ".quartet");
}

/** Where every identity on this machine lives. */
export function identitiesDirectory(): string {
  return join(getRootDirectory(), "identities");
}

/** Machine-level settings — nothing here belongs to one identity. */
export function machineConfigPath(): string {
  return join(getRootDirectory(), "config.json");
}

/** Point this run at an identity directory directly, wherever it is. `--data-dir`. */
export function setIdentityDirectory(path: string): void {
  identityOverride = expand(path);
}

/** Point this run at one of the identities under `~/.quartet/identities`. `--identity`. */
export function setIdentityLabel(chosen: string): void {
  label = chosen;
}

/**
 * A label that cannot become a path.
 *
 * Labels reach this from a flag and from a first-run answer, and both go straight into a
 * directory name. `..` would put an identity outside the folder that enumerates them, where
 * `listIdentityLabels` would never find it again.
 */
export function isUsableLabel(candidate: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(candidate) && candidate !== "." && candidate !== "..";
}

export function currentLabel(): string | undefined {
  return label;
}

/**
 * This identity's directory.
 *
 * Throws rather than guessing when nothing has chosen: every earlier version of this had a
 * default, the default was the root, and a default identity is exactly the assumption that
 * made a stale handle look like a fact.
 */
export function getDataDirectory(): string {
  if (identityOverride !== undefined) return identityOverride;
  if (label !== undefined) return join(identitiesDirectory(), label);
  throw new Error("no identity chosen — call setIdentityLabel or setIdentityDirectory first");
}

/** Whether an identity has been chosen at all, for the callers that must ask before reading. */
export function hasIdentity(): boolean {
  return identityOverride !== undefined || label !== undefined;
}

/**
 * The identities this machine holds, in a stable order.
 *
 * A directory is an identity when it holds a key. Anything else under `identities/` is
 * something else's — a half-written folder, an editor's droppings — and listing it as a
 * choice would offer somebody an identity that cannot sign.
 */
export async function listIdentityLabels(): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(identitiesDirectory(), { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const key = Bun.file(join(identitiesDirectory(), entry.name, "identity.json"));
    if (await key.exists()) found.push(entry.name);
  }
  return found.sort();
}

/**
 * Another identity's config, without becoming that identity.
 *
 * `configPath` answers for whichever identity this run has chosen. This is for the questions
 * that are about the others — which of them is already running, most of all.
 */
export function identityConfigPath(label: string): string {
  return join(identitiesDirectory(), label, "config.json");
}

/** Make this identity's directory, before anything tries to write a key into it. */
export async function makeIdentityDirectory(): Promise<void> {
  await mkdir(getDataDirectory(), { recursive: true });
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
 * Config is rewritten whenever a setting moves. The key is the one thing here that cannot be
 * regenerated without becoming a different agent.
 */
export function identityPath(): string {
  return join(getDataDirectory(), "identity.json");
}

/**
 * The keys this agent's words are sealed to, kept apart from `identity.json` on purpose.
 *
 * The identity key never changes and is never rewritten; a sealing key rotates, and every
 * key it ever retires has to be kept, because the ciphertext sealed to it does not re-seal
 * itself. Two lifetimes, two files. Losing this one loses the history rather than the handle:
 * the hub holds only what nothing here can now open.
 */
export function sealingPath(): string {
  return join(getDataDirectory(), "sealing.json");
}

/** Which key each handle is known by here. Not a secret — losing it costs a warning, not safety. */
export function knownPath(): string {
  return join(getDataDirectory(), "known.json");
}

/** How far each conversation's signature chain has reached. Derived, and not secret. */
export function journalPath(): string {
  return join(getDataDirectory(), "chain.json");
}
