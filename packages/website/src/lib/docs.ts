import type { CollectionEntry } from "astro:content";

/**
 * A doc's title, without requiring frontmatter.
 *
 * The docs are written to be read on GitHub first, where a `title:` key is noise above the
 * H1 that already says the same thing. So frontmatter stays optional and the H1 is the
 * fallback — a doc gains nothing by being told twice what it is called.
 */
export function titleOf(entry: CollectionEntry<"docs">): string {
  if (entry.data.title !== undefined) return entry.data.title;
  const heading = /^#\s+(.+)$/m.exec(entry.body ?? "");
  return heading?.[1]?.trim() ?? entry.id;
}

/**
 * The first sentence of prose, for meta descriptions and index cards.
 *
 * Skips the H1, blockquote callouts, tables and code so the summary is the doc's actual
 * first claim. The bold lead-in each doc opens with is kept — it is usually the best one
 * sentence about the doc that exists.
 */
export function summaryOf(entry: CollectionEntry<"docs">): string {
  if (entry.data.description !== undefined) return entry.data.description;
  const body = (entry.body ?? "")
    .replace(/^---[\s\S]*?---/, "")
    .split("\n")
    .filter((line: string) => {
      const text = line.trim();
      if (text.length === 0) return false;
      if (text.startsWith("#") || text.startsWith(">") || text.startsWith("|")) return false;
      if (text.startsWith("```")) return false;
      // Only a marker followed by a space is a list item. Matching a bare "*" would swallow
      // the bold lead-in every one of these docs opens with, which is exactly the sentence
      // worth summarising.
      if (/^([-*+]|\d+\.)\s/.test(text)) return false;
      return true;
    })
    .join(" ");
  const cleaned = body
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .trim();
  // Keep taking sentences until there is enough to be a summary. Several docs open on a
  // deliberate fragment — "Five minutes." — which is a fine first line and a useless
  // description on its own.
  let summary = "";
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) ?? [cleaned];
  for (const sentence of sentences) {
    summary += sentence;
    if (summary.trim().length >= 45) break;
  }
  return (summary.trim().length > 0 ? summary.trim() : cleaned).slice(0, 200);
}

/**
 * Reading order, which is not alphabetical order.
 *
 * A reader arriving at /docs should be walked from "see it in five minutes" to "run it with
 * somebody else", so the sequence is declared rather than derived. Anything unlisted sorts
 * after, alphabetically, so a new doc appears without having to touch this list.
 */
const ORDER = [
  "two-agents-locally",
  "your-agents",
  "a-room-of-personas",
  "hubs",
  "talk-to-a-friends-agent",
  "rooms",
  "turn-budget",
  "troubleshooting",
];

export function inReadingOrder(
  entries: CollectionEntry<"docs">[],
): CollectionEntry<"docs">[] {
  return [...entries].sort((left, right) => {
    const leftAt = left.data.order ?? ORDER.indexOf(left.id);
    const rightAt = right.data.order ?? ORDER.indexOf(right.id);
    if (leftAt !== rightAt) {
      if (leftAt < 0) return 1;
      if (rightAt < 0) return -1;
      return leftAt - rightAt;
    }
    return left.id.localeCompare(right.id);
  });
}
