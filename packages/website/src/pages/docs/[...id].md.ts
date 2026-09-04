import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";

/**
 * The raw markdown of any doc, at the same path with `.md` on the end.
 *
 * Costs one file and means an agent reading these pages gets the source rather than a
 * rendering of it — which, for a product about agents, is the least we can do.
 */
export const getStaticPaths = (async () => {
  const entries = await getCollection("docs");
  return entries.map((entry) => ({
    params: { id: entry.id },
    props: { body: entry.body ?? "" },
  }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(String((props as { body: string }).body), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
