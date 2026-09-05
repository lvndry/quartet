/**
 * @fileoverview What this machine remembers between runs.
 *
 * Split in two, along the line the old single file kept crossing. `MachineConfig` is where
 * jazz is listening, which is true of the host. `IdentityConfig` is one identity's own state,
 * and lives inside that identity's folder.
 *
 * The important absence is a handle. A handle is a row in one hub's database — that hub's
 * word for a key, not a property of the key — and storing it as a fact about this machine is
 * what let a bridge carry a name from a hub it had left to a hub that had never heard of it.
 * What is kept here instead is `hubs`: a *cache* of the answer each hub gave, refreshed from
 * the hub every time, and never consulted to decide whether a claim exists.
 *
 * No agent credential either: the socket is opened by signing a challenge with the key in
 * `identity.json`, which is kept apart because this file is rewritten whenever a port or a
 * hub URL changes. Two bearer tokens do live here — see `SECRET_FILE_MODE`.
 */

import { chmod, stat } from "node:fs/promises";
import type { StoredDevice } from "./devices";
import { writeJsonAtomically } from "./atomic";
import { configPath, hasIdentity, identityPath, machineConfigPath } from "./paths";

/**
 * Owner-only, for both files here that hold a secret.
 *
 * An identity's `config.json` holds the jazz webhook's bearer token, which can spend its
 * owner's model budget, and the local app's token, which is the whole of what guards a page
 * showing every conversation this identity is in. It also holds the paired-device list, whose
 * tokens are hashed rather than stored — but whose *presence* still decides who can drive
 * this agent. `identity.json` holds the private key. See `docs/design/local-files.md`.
 */
const SECRET_FILE_MODE = 0o600;

/**
 * How to reach the agent this identity speaks through.
 *
 * Assembled at startup rather than stored whole: the URL is the machine's, the webhook and
 * its token are this identity's. Everything downstream wants all three together, so the seam
 * stays at the point where they are read and written, not spread through the bridge.
 */
export interface DaemonSettings {
  /** Where jazz is listening. Loopback unless the operator deliberately moved it. */
  readonly url: string;
  /** Which webhook wakes the agent quartet talks through. */
  readonly webhook: string;
  /** That webhook's bearer token. Never sent to the hub. */
  readonly token: string;
}

/** True of the host, not of any one identity. */
export interface MachineConfig {
  /** Where jazz is listening for every identity here. */
  readonly daemonUrl?: string;
}

export interface IdentityConfig {
  /**
   * This identity's name *on this machine* — its folder, its webhook, its log lines.
   *
   * Seeded from the first handle claimed, because that is a name already chosen and typing a
   * second one would be a question with no better answer. It stops tracking it from then on:
   * a handle can differ per hub and can be taken by somebody else, and neither should rename
   * a directory or strand a webhook token keyed by name.
   */
  readonly label: string;
  /** The hub this identity last joined, and the default the next run offers. */
  readonly hubUrl: string;
  /**
   * Which jazz agent this identity speaks through.
   *
   * Recorded here rather than read back out of jazz's webhook entry, which is keyed by
   * webhook name: while several identities shared one name, an identity reading its own agent
   * out of it silently got somebody else's.
   */
  readonly agentId?: string;
  /** This identity's webhook and the token for it. The daemon's URL is the machine's. */
  readonly webhook?: { readonly name: string; readonly token: string };
  /** Guards the local app. Kept so the URL stays bookmarkable across restarts. */
  readonly localToken?: string;
  /** Which port the app is served on. Remembered so a second identity keeps its own. */
  readonly localPort?: number;
  /**
   * Devices paired to drive this agent from somewhere other than this machine.
   *
   * Each holds a hashed token, so this list is what stands between a tunnel URL and the
   * agent. Removing an entry here is revocation — see `docs/design/paired-devices.md`.
   */
  readonly devices?: readonly StoredDevice[];
  /**
   * What each hub called this key, last time it was asked. A cache, and nothing more.
   *
   * Never read to decide whether this key is claimed somewhere — that question is settled by
   * asking the hub, every time. This exists so a familiar hub can be named in a log line
   * before the socket is up, and so a re-claim has a sensible default to offer.
   */
  readonly hubs?: Readonly<Record<string, { readonly handle: string }>>;
}

export const DEFAULT_HUB_URL = "http://localhost:8080";

/**
 * Whether a hub URL is a cloudflare quick tunnel — the kind `hub --tunnel` prints.
 *
 * Not a judgement about whether to use one: a quick tunnel is a perfectly good way to keep a
 * hub up for other people, and plenty of them run for weeks. It is about one property those
 * hostnames have and no others do — they are handed out anonymously, so cloudflare owes
 * nobody the same name twice, and a hub that restarts comes back at a different address.
 *
 * Worth naming specifically because of what that failure looks like from the other end: a URL
 * that worked yesterday and answers nothing today is indistinguishable from a typo, and the
 * advice for a typo is useless here.
 */
export function isQuickTunnel(hubUrl: string): boolean {
  try {
    return new URL(hubUrl).hostname.endsWith(".trycloudflare.com");
  } catch {
    return false;
  }
}

export { configPath };

export async function loadMachineConfig(): Promise<MachineConfig> {
  const file = Bun.file(machineConfigPath());
  if (!(await file.exists())) return {};
  try {
    return (await file.json()) as MachineConfig;
  } catch {
    return {};
  }
}

export async function saveMachineConfig(config: MachineConfig): Promise<void> {
  await writeJsonAtomically(machineConfigPath(), config, SECRET_FILE_MODE);
}

/**
 * One identity's own state.
 *
 * `label` and `hubUrl` are filled in by the caller that created this identity, so a config
 * that has lost them still parses into something usable rather than throwing during startup.
 */
export async function loadIdentityConfig(label: string): Promise<IdentityConfig> {
  const fallback: IdentityConfig = {
    label,
    hubUrl: process.env["QUARTET_HUB"] ?? DEFAULT_HUB_URL,
  };
  const file = Bun.file(configPath());
  if (!(await file.exists())) return fallback;
  try {
    const parsed = (await file.json()) as Partial<IdentityConfig>;
    return {
      ...parsed,
      label: parsed.label ?? label,
      hubUrl: process.env["QUARTET_HUB"] ?? parsed.hubUrl ?? fallback.hubUrl,
    };
  } catch {
    // A corrupt config should not wedge the CLI: falling back to defaults lets `connect`
    // walk the user through setup again, which rewrites the file anyway.
    return fallback;
  }
}

export async function saveIdentityConfig(config: IdentityConfig): Promise<void> {
  await writeJsonAtomically(configPath(), config, SECRET_FILE_MODE);
}

/** What this hub called us last time we asked it. A hint for a prompt, never a claim. */
export function rememberedHandle(config: IdentityConfig, hubUrl: string): string | undefined {
  return config.hubs?.[hubUrl]?.handle;
}

/** Record what a hub just said it calls this key, replacing whatever was cached. */
export function withHandle(
  config: IdentityConfig,
  hubUrl: string,
  handle: string,
): IdentityConfig {
  return { ...config, hubs: { ...config.hubs, [hubUrl]: { handle } } };
}

/**
 * Narrow the permissions on anything here that already exists.
 *
 * At startup, because `saveIdentityConfig` only fixes a file when it is next written and the
 * common case is one written months ago. Failures are reported rather than thrown: a bridge
 * that will not start is worse than one that starts and says so.
 */
export async function hardenSecretFiles(): Promise<string[]> {
  const problems: string[] = [];
  // Only once an identity is chosen: before that there is no directory to look in, and the
  // machine file holds nothing secret.
  if (!hasIdentity()) return problems;
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
