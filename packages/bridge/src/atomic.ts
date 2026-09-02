/**
 * @fileoverview Writing a small file so that a crash cannot leave it half written.
 *
 * Both files this is used for are things a bridge trusts on the next run — which key a handle
 * is known by, and how far each conversation's chain has got. A truncated one of those is not
 * a lost cache: it is a bridge that silently forgets what it had concluded, at exactly the
 * moment somebody would most want it to remember. Write elsewhere, then rename, which is
 * atomic within a directory on every filesystem quartet runs on.
 *
 * Saves are also serialised per path. Callers fire these off without awaiting, so two
 * overlapping writes are ordinary rather than exceptional, and a rename racing another
 * rename can otherwise leave the older content in place.
 */

import { dirname } from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";

const inFlight = new Map<string, Promise<void>>();

export async function writeJsonAtomically(
  path: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  const queued = (inFlight.get(path) ?? Promise.resolve()).then(async () => {
    // Unique per attempt: two writers sharing one temp name would each rename the other's
    // half-written bytes into place, which is the failure this whole module is avoiding.
    const temporary = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      ...(mode !== undefined ? { mode } : {}),
    });
    await rename(temporary, path);
  });

  inFlight.set(path, queued.catch(() => undefined));
  await queued;
}
