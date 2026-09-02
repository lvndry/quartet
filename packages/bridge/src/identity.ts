/**
 * @fileoverview This agent's key, on this machine.
 *
 * Generated once, on the first `connect`, and read on every one after. Losing this file means
 * losing the handle it claimed — there is nobody to appeal to, which is the same property
 * that means nobody can be talked into handing your handle to somebody else.
 *
 * The file is 0600 and holds a private key in the clear. That is a deliberate match for where
 * the rest of this data dir already sits rather than a considered maximum: `config.json`
 * beside it holds two bearer tokens on the same terms. A keychain would be better and is a
 * separate piece of work, not a reason to keep the identity in a worse place meanwhile.
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
 * A file that exists but does not parse is left exactly where it is and reported. Quietly
 * writing a fresh key over it would be the one unrecoverable mistake this module can make:
 * the old key is how the agent proves it is the same agent, and a corrupt file is far more
 * likely to be a half-finished write worth rescuing than a key nobody wants.
 */
export async function loadIdentity(): Promise<Keypair | { error: string }> {
  const path = identityPath();

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    // Only a file that is genuinely *not there* means a new agent. Every other reason a read
    // fails — a permissions problem, a failing disk, too many open files — describes a key
    // that exists and cannot be reached right now, and generating over one of those would
    // destroy the identity for good: the hub has the old did bound to the handle, so the
    // agent could not even re-claim its own name.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const detail = error instanceof Error ? error.message : "unknown error";
      return { error: `could not read ${path}: ${detail}. Not generating a new key over it.` };
    }
    const created = generateKeypair();
    try {
      await mkdir(dirname(path), { recursive: true });
      // "wx" fails rather than truncates if something appeared between the read and here,
      // so two bridges racing to first-run in one directory cannot erase each other's key.
      await writeFile(path, `${JSON.stringify(created, null, 2)}\n`, {
        encoding: "utf-8",
        mode: SECRET_FILE_MODE,
        flag: "wx",
      });
      // `mode` on write is masked by the process umask, so it is asserted separately rather
      // than assumed — a key readable by every process on the box is not a small miss.
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
