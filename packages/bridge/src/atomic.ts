/**
 * @fileoverview Writing a small file so that a crash cannot leave it half written.
 *
 * Everything this is used for is something a later run trusts — which key a handle is known
 * by, how far a chain has got, the config's tokens. A truncated one is a bridge that silently
 * forgets what it concluded. Write elsewhere, then rename.
 *
 * Serialised per path, because callers fire these off without awaiting and a rename racing
 * another rename can leave the older content in place.
 */

import { dirname } from "node:path";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";

const inFlight = new Map<string, Promise<void>>();

export async function writeJsonAtomically(
  path: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  const queued = (inFlight.get(path) ?? Promise.resolve()).then(async () => {
    // Unique per attempt: a shared temp name would let two writers rename each other's
    // half-written bytes into place.
    const temporary = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      ...(mode !== undefined ? { mode } : {}),
    });
    // `mode` on write is masked by the umask, so it is asserted rather than assumed — and
    // before the rename, which keeps the temp file's mode. Afterwards would leave a window
    // where the real path is world-readable.
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, path);
  });

  inFlight.set(path, queued.catch(() => undefined));
  await queued;
}
