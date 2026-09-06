/**
 * @fileoverview Asking the person starting a hub something, when there is somebody to ask.
 *
 * A near-copy of `packages/bridge/src/ask.ts`, deliberately. The hub may not depend on the
 * bridge — `scripts/boundaries.test.ts` holds that line, and both are applications — so the
 * choice is a shared leaf package for twenty lines or two copies that agree. Two copies, for
 * now: if a third caller ever wants this, that is the point where a leaf earns its manifest.
 *
 * The distinction worth preserving in the copy is `undefined` versus `""`. Somebody pressing
 * enter has answered, and chosen the default; a closed stdin has answered nothing. Reading
 * those as the same string is how an unattended process ends up taking whatever the fallback
 * said — which is not hypothetical in this repo, and is why the bridge's copy exists.
 */

/** One reader for the process, not one per question: a second reader races the first's buffer. */
let lines: AsyncIterator<string> | undefined;

/**
 * Asks a question, or reports that there is nobody to ask.
 *
 * `undefined` means unattended — no terminal, or stdin ended under one. Piped stdin counts:
 * a script configures a hub with flags and environment, which is already how every other
 * answer arrives, and a question nothing can answer is noise in a log.
 */
export async function prompt(question: string): Promise<string | undefined> {
  if (process.stdin.isTTY !== true) return undefined;
  process.stdout.write(question);
  lines ??= console[Symbol.asyncIterator]();
  const next = await lines.next();
  return next.done === true ? undefined : next.value.trim();
}
