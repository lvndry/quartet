/**
 * @fileoverview What this machine remembers between runs.
 *
 * No agent credential lives here any more. The socket is opened by signing a challenge with
 * the key in `identity.json`, so the only secret in this file is the **daemon token**, which
 * wakes your local jazz agent and must never leave loopback. The identity is deliberately
 * kept in its own file: this one is rewritten whenever a port or a hub URL changes.
 */

import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { configPath } from "./paths";

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
   * Recorded here rather than read back out of jazz's webhook entry. The entry is keyed by
   * webhook name, and while several identities shared one name it was not this identity's
   * record at all — it was whatever the last `connect` on this host happened to write. An
   * identity that read its own agent out of it got somebody else's, silently.
   *
   * Per the 1b config split this is identity-level state, alongside `handle` and the webhook
   * name, while `daemon` is machine-level.
   */
  readonly agentId?: string;
  readonly daemon?: DaemonSettings;
  /** Which port the app is served on. Remembered so a second agent keeps its own. */
  readonly localPort?: number;
  /**
   * Guards the local app. Kept so the URL stays the same across restarts, which is what
   * makes it bookmarkable — and this file already holds the daemon and agent tokens, both of
   * which reach further than a loopback page does.
   */
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
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
}
