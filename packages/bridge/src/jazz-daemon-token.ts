/**
 * @fileoverview The jazz daemon's own bearer token, for connect-time admin calls.
 *
 * Jazz provisions one on every bind — loopback included — and stores it in the OS keyring
 * (or `$JAZZ_HOME/secrets.json`). Health stays open; `/agents` and the rest require
 * `Authorization: Bearer …`. Quartet used to assume loopback needed none; that stopped being
 * true the moment jazz started minting tokens automatically.
 *
 * Same resolution order as jazz itself: `$JAZZ_DAEMON_TOKEN`, then the keyring entry
 * `daemon.token` under service `jazz`. Read-only — never call `jazz daemon set-token`, which
 * overwrites the live credential and strands every other client.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Matches jazz's `DAEMON_TOKEN_ENV_VAR`. */
export const JAZZ_DAEMON_TOKEN_ENV = "JAZZ_DAEMON_TOKEN";

/** Matches jazz's keyring service name and `DAEMON_TOKEN_PATH`. */
const KEYRING_SERVICE = "jazz";
const DAEMON_TOKEN_ACCOUNT = "daemon.token";

/**
 * Resolve the daemon admin token jazz is currently serving behind.
 *
 * Returns `undefined` when nothing is configured — the caller then hits `/agents` without a
 * Bearer header and surfaces jazz's 401 with advice to set the env var.
 */
export async function resolveJazzDaemonToken(): Promise<string | undefined> {
  const fromEnv = process.env[JAZZ_DAEMON_TOKEN_ENV];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();

  const fromKeyring = await readDaemonTokenFromKeyring();
  if (fromKeyring !== undefined) return fromKeyring;

  return readDaemonTokenFromSecretsFile();
}

async function readDaemonTokenFromKeyring(): Promise<string | undefined> {
  if (process.platform === "darwin") {
    return runAndTrim("security", [
      "find-generic-password",
      "-w",
      "-s",
      KEYRING_SERVICE,
      "-a",
      DAEMON_TOKEN_ACCOUNT,
    ]);
  }
  if (process.platform === "linux") {
    // Prefer libsecret when the session bus is up; fall through to the file below otherwise.
    return runAndTrim("secret-tool", [
      "lookup",
      "service",
      KEYRING_SERVICE,
      "account",
      DAEMON_TOKEN_ACCOUNT,
    ]);
  }
  return undefined;
}

async function readDaemonTokenFromSecretsFile(): Promise<string | undefined> {
  const home = process.env["JAZZ_HOME"]?.trim() || join(homedir(), ".jazz");
  try {
    const raw = await readFile(join(home, "secrets.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[DAEMON_TOKEN_ACCOUNT];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function runAndTrim(command: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const child = Bun.spawn({ cmd: [command, ...args], stdout: "pipe", stderr: "pipe" });
    const printed = await new Response(child.stdout).text().catch(() => "");
    const code = await child.exited.catch(() => 1);
    if (code !== 0) return undefined;
    const value = printed.replace(/\n$/, "").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
