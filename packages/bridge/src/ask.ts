/**
 * @fileoverview Asking somebody something, when there is somebody to ask.
 *
 * The distinction this module exists for is between an empty answer and no answer. A person
 * pressing enter is taking the default and has chosen it; a closed stdin has chosen nothing,
 * and reading the two as the same string is how a question gets answered by whoever wrote its
 * fallback.
 *
 * That is not hypothetical here. `connect` offers to install jazz when it cannot find one,
 * declining only on an answer starting with "n" — so silence was a yes, and the first CI run
 * of the binary smoke test curl-piped jazz's installer onto a GitHub runner and reported a
 * pass. Returning `undefined` makes every caller say what unattended means, in the type
 * checker rather than in review.
 */

/**
 * One reader for the whole session, not one per question.
 *
 * `for await (const line of console)` opens a fresh reader over stdin each time it is
 * evaluated, so a second prompt races the first one's buffer and the answers land against
 * the wrong questions. Holding a single iterator is the fix.
 *
 * Made on first use rather than at import, so loading this module does not reach for stdin on
 * behalf of a command that never asks anything.
 */
let lines: AsyncIterator<string> | undefined;

/**
 * Asks a question, or reports that there is nobody to ask.
 *
 * `undefined` means unattended — no terminal, or stdin ended under one. It is deliberately
 * not the empty string, which still means somebody pressed enter.
 *
 * Piped stdin counts as unattended: a script answers quartet with flags, which is already how
 * `--hub`, `--identity` and `--agent` work, and inventing a second answer channel would mean
 * two ways to say the same thing and one of them undocumented. Nothing is printed in that
 * case either — a question nothing can answer is noise in a log.
 */
export async function prompt(question: string): Promise<string | undefined> {
  if (process.stdin.isTTY !== true) return undefined;
  process.stdout.write(question);
  lines ??= console[Symbol.asyncIterator]();
  const next = await lines.next();
  return next.done === true ? undefined : next.value.trim();
}
