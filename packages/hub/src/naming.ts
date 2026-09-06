/**
 * @fileoverview Where a hub's database lives, and who is allowed to have it open.
 *
 * A hub used to keep its state in `quartet.sqlite`, relative to whatever directory it was
 * started from. That is fine for exactly one hub started from exactly one place, and quietly
 * wrong everywhere else: two hubs launched from the same shell shared one database without
 * saying so, each holding its own in-memory idea of who was connected, and the store opens
 * WAL without a busy timeout so their writes raced into `SQLITE_BUSY`.
 *
 * The fix is to file a hub under its name, which it already had — the name on the `/join`
 * page is the thing that distinguishes one hub from another to a person, so it is the right
 * thing to distinguish them to the filesystem. `--name` is required for that reason: a hub
 * with no name has nothing to be filed under and nothing to be found by on the next restart.
 *
 * `QUARTET_HOME` is resolved here rather than imported. The hub has no business depending on
 * the bridge's paths, and `@quartet/tunnel` resolves it the same way for the same reason.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where this machine keeps quartet's data. The same `~/.quartet` the bridge writes into. */
export function quartetHome(): string {
  const configured = process.env["QUARTET_HOME"];
  if (configured === undefined || configured.length === 0) return join(homedir(), ".quartet");
  return configured.startsWith("~") ? join(homedir(), configured.slice(1)) : configured;
}

/**
 * A filename for a hub's name.
 *
 * Undefined when nothing survives, which is a real answer rather than a defect: `--name "🎷"`
 * is a perfectly good name for a room and a terrible one for a file, and inventing a
 * substitute would file the hub somewhere the person cannot predict or find again.
 */
export function slugForName(name: string): string | undefined {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return slug.length === 0 ? undefined : slug;
}

/** Where the hub called `name` keeps its state, or undefined if the name yields no filename. */
export function databaseForName(name: string): string | undefined {
  const slug = slugForName(name);
  return slug === undefined ? undefined : join(quartetHome(), "hubs", `${slug}.sqlite`);
}

export type Claim =
  | { readonly kind: "held"; readonly release: () => void }
  | { readonly kind: "taken"; readonly pid: number };

/**
 * Take exclusive use of a database file, or report who already has it.
 *
 * Deriving the path from the name means two hubs sharing a name now share a database by
 * default rather than by mistake, which is worse than the problem it replaced. This is the
 * guard: a pid in a file beside the database, checked for life before it is believed.
 *
 * A lock whose process is gone is taken over rather than respected. A hub killed with
 * SIGKILL, or one whose SIGINT went unhandled, leaves its lock behind — and a hub that
 * refuses to start because of its own previous crash is a hub somebody has to know to go and
 * delete a file to recover, which is the kind of thing nobody remembers at 2am.
 */
export function claimDatabase(path: string): Claim {
  const lock = `${path}.lock`;
  const holder = readHolder(lock);
  if (holder !== undefined && isAlive(holder)) return { kind: "taken", pid: holder };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(lock, String(process.pid), "utf8");

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    // Only if it is still ours. Something took it over while we were running means our own
    // claim is already gone, and deleting theirs would hand the database to a third hub.
    if (readHolder(lock) === process.pid) rmSync(lock, { force: true });
  };
  // Covers `process.exit` as well as falling off the end. A signal that kills the process
  // outright leaves the lock, which is exactly what the staleness check above is for.
  process.on("exit", release);
  return { kind: "held", release };
}

function readHolder(lock: string): number | undefined {
  if (!existsSync(lock)) return undefined;
  try {
    const pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a pid belongs to something still running.
 *
 * `EPERM` counts as alive: the process exists, it just belongs to another user. Reading that
 * as "gone" would let a second hub take a database out from under a first one running as
 * somebody else.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
