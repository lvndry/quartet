/**
 * @fileoverview The keys this agent's words are sealed to, on this machine.
 *
 * `identity.ts` next door holds the key that says who this agent *is*. This holds the key
 * that decides what it can *read*, and the difference shows up in how each file fails. Lose
 * the identity and the handle is gone, with nobody to appeal to. Lose this and the handle is
 * fine — every conversation it ever had is what stops opening, because the hub kept only
 * ciphertext and the keys were never anywhere else.
 *
 * Which is why retired keys are kept rather than dropped. A rotation changes what future
 * lines are sealed to; it does nothing to the years of lines already sealed to the old key,
 * and a bridge that discarded it would silently make its own past unreadable.
 *
 * Same 0600, same clear-text private key, same reasoning as the identity file: it matches
 * where the rest of this data dir already sits, and a keychain is a separate piece of work.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { generateSealingKeypair, isSealingDid, type SealingKeypair } from "@quartet/identity";
import { sealingPath } from "./paths";

const SECRET_FILE_MODE = 0o600;

/**
 * Every sealing key this agent has held, newest first in intent.
 *
 * `current` is what other agents are told to seal to. `retired` is what still has to open the
 * archive, and it only ever grows — a sealing key is small and a conversation is forever.
 */
export interface SealingKeys {
  readonly current: SealingKeypair;
  readonly retired: readonly SealingKeypair[];
}

function isSealingKeypair(value: unknown): value is SealingKeypair {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { sealingDid?: unknown; privateKey?: unknown };
  return (
    typeof candidate.sealingDid === "string" &&
    typeof candidate.privateKey === "string" &&
    isSealingDid(candidate.sealingDid)
  );
}

function isSealingKeys(value: unknown): value is SealingKeys {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { current?: unknown; retired?: unknown };
  return (
    isSealingKeypair(candidate.current) &&
    Array.isArray(candidate.retired) &&
    candidate.retired.every(isSealingKeypair)
  );
}

/**
 * The sealing keys for this data directory, generating the first one on demand.
 *
 * A file that exists but does not parse is left exactly where it is and reported, for the
 * same reason `loadIdentity` refuses to write over a damaged identity — except that here the
 * damaged file is the only copy of the key to every conversation this agent has had. There is
 * no recovering that from the hub, so a half-finished write is worth a person looking at.
 */
export async function loadSealingKeys(): Promise<SealingKeys | { error: string }> {
  const path = sealingPath();

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    // Only genuinely absent means a new agent. Every other read failure describes keys that
    // exist and cannot be reached this second, and generating over those would throw away
    // the archive for good.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const detail = error instanceof Error ? error.message : "unknown error";
      return { error: `could not read ${path}: ${detail}. Not generating new keys over it.` };
    }

    const created: SealingKeys = { current: generateSealingKeypair(), retired: [] };
    try {
      await mkdir(dirname(path), { recursive: true });
      // "wx" rather than a truncating write: two bridges racing to first-run in one directory
      // must not erase each other's keys.
      await writeFile(path, `${JSON.stringify(created, null, 2)}\n`, {
        encoding: "utf-8",
        mode: SECRET_FILE_MODE,
        flag: "wx",
      });
      await chmod(path, SECRET_FILE_MODE);
    } catch (writeError) {
      const detail = writeError instanceof Error ? writeError.message : "unknown error";
      return { error: `could not write ${path}: ${detail}` };
    }
    return created;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isSealingKeys(parsed)) {
      return { error: `${path} is not a quartet sealing key file. Move it aside to start over.` };
    }
    return parsed;
  } catch {
    return { error: `${path} is not readable JSON. Move it aside to start over.` };
  }
}

/**
 * Try the current key, then every retired one.
 *
 * Ordered rather than indexed by did because the envelope names the key it was sealed to and
 * the caller has already matched on it; this exists for the caller that has not, and the
 * archive is a handful of keys, not a table.
 */
export function everyKey(keys: SealingKeys): readonly SealingKeypair[] {
  return [keys.current, ...keys.retired];
}
