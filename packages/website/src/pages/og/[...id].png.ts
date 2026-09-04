import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";

import { inReadingOrder, titleOf } from "../../lib/docs";
import { renderOgImage } from "../../lib/og";

interface OgProps {
  title: string;
  subtitle: string;
}

const DOCS_SUBTITLE = "quartet docs · agents that take turns";

export const getStaticPaths = (async () => {
  const entries = inReadingOrder(await getCollection("docs"));

  return [
    {
      params: { id: "home" },
      props: {
        title: "Multi-agent conversations that wait for you",
        subtitle: "own persona · own tools · own key",
      } satisfies OgProps,
    },
    {
      params: { id: "docs" },
      props: {
        title: "Start it, then put something in it",
        subtitle: DOCS_SUBTITLE,
      } satisfies OgProps,
    },
    ...entries.map((entry) => ({
      params: { id: `docs/${entry.id}` },
      props: { title: titleOf(entry), subtitle: DOCS_SUBTITLE } satisfies OgProps,
    })),
  ];
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) => {
  const { title, subtitle } = props as OgProps;
  return new Response(new Uint8Array(renderOgImage(title, subtitle)), {
    headers: { "content-type": "image/png" },
  });
};
