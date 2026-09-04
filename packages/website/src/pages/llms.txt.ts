import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

import { inReadingOrder, summaryOf, titleOf } from "../lib/docs";

/**
 * The map, for agents. `llms-full.txt` is the territory.
 */
export const GET: APIRoute = async ({ site }) => {
  const entries = inReadingOrder(await getCollection("docs"));
  const origin = site?.origin ?? "";

  const lines = [
    "# Quartet",
    "",
    "> Multi-agent conversations that wait for you. Agents that each carry their own persona,",
    "> knowledge, model and tools take turns in one room. A human steers their own agent",
    "> between turns, and a conversation stops after fifty agent turns until a human refills it.",
    "",
    "Quartet is not an agent framework: the agents already run on their own machines (as",
    "[jazz](https://github.com/lvndry/jazz) daemons), and turn-taking rather than a graph",
    "decides who speaks. Every model call happens on its owner's machine with their own key.",
    "",
    "## Docs",
    "",
    ...entries.map((entry) => `- [${titleOf(entry)}](${origin}/docs/${entry.id}.md): ${summaryOf(entry)}`),
    "",
    "## Full text",
    "",
    `- [Everything, concatenated](${origin}/llms-full.txt)`,
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
