/**
 * @fileoverview What this machine remembers between runs.
 *
 * No agent credential: the socket is opened by signing a challenge with the key in
 * `identity.json`, which is kept apart because this file is rewritten whenever a port or a
 * hub URL changes. Two bearer tokens do live here — see `SECRET_FILE_MODE`.
 */

import { chmod, stat } from "node:fs/promises";
import { writeJsonAtomically } from "./atomic";
import { configPath, identityPath } from "./paths";

/**
 * Owner-only, for both files here that hold a secret.
 *
 * `config.json` holds the jazz webhook's bearer token, which can spend its owner's model
 * budget, and the local app's token, which is the whole of what guards a page showing every
 * conversation on this machine. `identity.json` holds the private key. See
 * `docs/design/local-files.md`.
 */
const SECRET_FILE_MODE = 0o600;

export interface DaemonSettings {
  /** Where jazz is listening. Loopback unless the operator deliberately moved it. */
  readonly url: string;
  /** Which webhook wakes the agent quartet talks through. */
  readonly webhook: string;
  /** That webhook's bearer token. Never sent to the hub. */
  readonly token: string;
}

export interface QuartetConfig {
  readonly hubUrl: string;
  readonly handle?: string;
  /**
   * Which jazz agent this identity speaks through.
   *
   * Recorded here rather than read back out of jazz's webhook entry, which is keyed by
   * webhook name: while several identities shared one name, an identity reading its own agent
   * out of it silently got somebody else's. Identity-level state, unlike `daemon`.
   */
  readonly agentId?: string;
  readonly daemon?: DaemonSettings;
  /** Which port the app is served on. Remembered so a second agent keeps its own. */
  readonly localPort?: number;
  /** Guards the local app. Kept so the URL stays bookmarkable across restarts. */
  readonly localToken?: string;
}

export const DEFAULT_HUB_URL = "http://localhost:8080";

export { configPath };

export async function loadConfig(): Promise<QuartetConfig> {
  const file = Bun.file(configPath());
  if (!(await file.exists())) return { hubUrl: process.env["QUARTET_HUB"] ?? DEFAULT_HUB_URL };
  try {
    const parsed = (await file.json()) as QuartetConfig;
    return { ...parsed, hubUrl: process.env["QUARTET_HUB"] ?? parsed.hubUrl ?? DEFAULT_HUB_URL };
  } catch {
    // A corrupt config should not wedge the CLI: falling back to defaults lets `connect`
    // walk the user through setup again, which rewrites the file anyway.
    return { hubUrl: process.env["QUARTET_HUB"] ?? DEFAULT_HUB_URL };
  }
}

export async function saveConfig(config: QuartetConfig): Promise<void> {
  await writeJsonAtomically(configPath(), config, SECRET_FILE_MODE);
}

/**
 * Narrow the permissions on anything here that already exists.
 *
 * At startup, because `saveConfig` only fixes a file when it is next written and the common
 * case is one written months ago. Failures are reported rather than thrown: a bridge that
 * will not start is worse than one that starts and says so.
 */
export async function hardenSecretFiles(): Promise<string[]> {
  const problems: string[] = [];
  for (const path of [configPath(), identityPath()]) {
    try {
      const info = await stat(path);
      // Only the permission bits, and only when something outside the owner can see them.
      if ((info.mode & 0o077) === 0) continue;
      await chmod(path, SECRET_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      const detail = error instanceof Error ? error.message : "unknown error";
      problems.push(`${path}: ${detail}`);
    }
  }
  return problems;
}
