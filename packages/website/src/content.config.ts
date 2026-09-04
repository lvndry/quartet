import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

/**
 * The docs are the repo's own `docs/` folder, not a copy of it. What somebody reads on
 * GitHub is what the site builds, so the two cannot disagree.
 *
 * `design/` is excluded: it is written for whoever is building quartet, not for whoever is
 * using it, and it says so in its own frontmatter status lines.
 */
export const collections = {
  docs: defineCollection({
    loader: glob({
      pattern: ["**/*.md", "!design/**", "!design.md", "!README.md"],
      base: "../../docs",
    }),
    schema: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
      order: z.number().optional(),
    }),
  }),
};
