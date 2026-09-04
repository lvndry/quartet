/**
 * @fileoverview This agent's key, on this machine.
 *
 * Generated once on the first `connect`. Losing it loses the handle it claimed — the same
 * property that means nobody can be talked into handing your handle away. 0600, in the clear;
 * see `docs/design.md` §7 for why that is a match for the rest of the directory rather than a
 * considered maximum.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { generateKeypair, isDid, type Keypair } from "@quartet/identity";
import { identityPath } from "./paths";

const SECRET_FILE_MODE = 0o600;

function isKeypair(value: unknown): value is Keypair {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { did?: unknown; privateKey?: unknown };
  return (
    typeof candidate.did === "string" &&
    typeof candidate.privateKey === "string" &&
    isDid(candidate.did)
  );
}

/**
 * The keypair for this data directory, generating one the first time.
 *
 * A file that exists but does not parse is left where it is and reported. Writing a fresh key
 * over it is the one unrecoverable mistake available here.
 */
export async function loadIdentity(): Promise<Keypair | { error: string }> {
  const path = identityPath();

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    // Only a genuine ENOENT means a new agent. Every other failure describes a key that
    // exists and cannot be reached, and generating over one would destroy the identity: the
    // hub has the old did bound to the handle, so it could not even re-claim its own name.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const detail = error instanceof Error ? error.message : "unknown error";
      return { error: `could not read ${path}: ${detail}. Not generating a new key over it.` };
    }
    const created = generateKeypair();
    try {
      await mkdir(dirname(path), { recursive: true });
      // "wx" fails rather than truncates, so two bridges racing to first-run in one directory
      // cannot erase each other's key.
      await writeFile(path, `${JSON.stringify(created, null, 2)}\n`, {
        encoding: "utf-8",
        mode: SECRET_FILE_MODE,
        flag: "wx",
      });
      // Masked by the umask on write, so asserted separately.
      await chmod(path, SECRET_FILE_MODE);
    } catch (writeError) {
      const detail = writeError instanceof Error ? writeError.message : "unknown error";
      return { error: `could not write ${path}: ${detail}` };
    }
    return created;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isKeypair(parsed)) {
      return { error: `${path} is not a quartet identity. Move it aside to start over.` };
    }
    return parsed;
  } catch {
    return { error: `${path} is not readable JSON. Move it aside to start over.` };
  }
}
