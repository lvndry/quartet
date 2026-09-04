import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

import { inReadingOrder, titleOf } from "../lib/docs";

/** Every doc, in reading order, as one plain-text file. */
export const GET: APIRoute = async () => {
  const entries = inReadingOrder(await getCollection("docs"));

  const body = entries
    .map((entry) => `<!-- ${titleOf(entry)} — /docs/${entry.id} -->\n\n${entry.body ?? ""}`)
    .join("\n\n---\n\n");

  return new Response(`# Quartet — documentation\n\n${body}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
