/**
 * @fileoverview What this machine remembers between runs.
 *
 * Two secrets live here and neither should ever be confused with the other: the **agent
 * token** proves to the hub that this socket is your agent, and the **daemon token** wakes
 * your local jazz agent. The first crosses the network; the second must never leave
 * loopback. Keeping them in one file is fine — keeping them in one field would not be.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";

export interface DaemonSettings {
  /** Where jazz is listening. Loopback unless the operator deliberately moved it. */
  readonly url: string;
  /** Which trigger wakes the agent quartet talks through. */
  readonly trigger: string;
  /** That trigger's bearer token. Never sent to the hub. */
  readonly token: string;
}

export interface QuartetConfig {
  readonly hubUrl: string;
  readonly agentToken?: string;
  readonly handle?: string;
  readonly daemon?: DaemonSettings;
}

export const DEFAULT_HUB_URL = "http://localhost:8080";

export function configPath(): string {
  return join(process.env["QUARTET_HOME"] ?? join(homedir(), ".quartet"), "config.json");
}

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
