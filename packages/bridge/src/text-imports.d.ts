/**
 * @fileoverview Markdown imported as text.
 *
 * Bun resolves `with { type: "text" }` on any extension; TypeScript only believes it for the
 * ones something has declared. The hub's `.css` and `.svg` imports get theirs through
 * `@quartet/theme`'s export map — a relative `./instructions.md` has no such map, so it says
 * so here.
 */
declare module "*.md" {
  const contents: string;
  export default contents;
}
