/**
 * @fileoverview The jazz agents on this machine, so setup can offer a choice.
 *
 * Asked of the daemon over `GET /agents`, which is the only thing that actually knows. The
 * first version of this read `~/.jazz/agents/*.json` directly and worked out where they
 * lived from `storage.path` — coupling quartet to jazz's on-disk layout for a question jazz
 * is perfectly able to answer, and wrong the moment that layout changes.
 *
 * This replaces a free-text prompt whose default was the string "default", which is a
 * *persona* name in jazz and matches no agent id or name on a normal machine. Pressing enter
 * therefore wrote a webhook pointing at an agent that does not exist, and nothing said so
 * until turns started failing — long after setup looked fine.
 */

export interface JazzAgent {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly persona?: string;
  readonly tools: readonly string[];
}

/**
 * Why the agent list could not be had, in terms the wizard can act on.
 *
 * Three outcomes rather than a null, because they need three different things said: start
 * the daemon, give quartet the daemon's token, or upgrade jazz.
 */
export type AgentListing =
  | { readonly kind: "ok"; readonly agents: JazzAgent[] }
  | { readonly kind: "unreachable" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly detail: string };

export async function fetchJazzAgents(daemonUrl: string, token?: string): Promise<AgentListing> {
  let response: Response;
  try {
    response = await fetch(new URL("/agents", daemonUrl), {
      headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
    });
  } catch {
    return { kind: "unreachable" };
  }

  if (response.status === 401) return { kind: "unauthorized" };
  // A jazz from before this route existed answers its catch-all rather than a list.
  if (response.status === 404) return { kind: "unsupported" };
  if (!response.ok) return { kind: "failed", detail: `the daemon answered ${String(response.status)}` };

  const body = (await response.json().catch(() => null)) as { agents?: unknown } | null;
  if (!Array.isArray(body?.agents)) return { kind: "unsupported" };

  const agents = body.agents
    .map(toAgent)
    .filter((agent): agent is JazzAgent => agent !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
  return { kind: "ok", agents };
}

function toAgent(raw: unknown): JazzAgent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  const name = record["name"];
  if (typeof id !== "string" || typeof name !== "string") return undefined;

  const text = (key: string): string | undefined =>
    typeof record[key] === "string" && (record[key] as string).length > 0
      ? (record[key] as string)
      : undefined;
  const description = text("description");
  const provider = text("provider");
  const model = text("model");
  const persona = text("persona");

  return {
    id,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(persona !== undefined ? { persona } : {}),
    tools: Array.isArray(record["tools"])
      ? record["tools"].filter((tool): tool is string => typeof tool === "string")
      : [],
  };
}

/**
 * Which agent an answer refers to: a number from the list, a name, or an id.
 *
 * Names before ids because that is what somebody reading the list will type, and jazz itself
 * resolves either. A number is only meaningful against the list as it was printed, so the
 * caller passes the same array it showed.
 */
export function resolveAgentChoice(
  agents: readonly JazzAgent[],
  answer: string,
): JazzAgent | undefined {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    return index >= 0 && index < agents.length ? agents[index] : undefined;
  }
  const lowered = trimmed.toLowerCase();
  return (
    agents.find((agent) => agent.name.toLowerCase() === lowered) ??
    agents.find((agent) => agent.id === trimmed)
  );
}

/** `provider/model`, or whichever half is known. */
export function describeModel(agent: JazzAgent): string {
  if (agent.provider !== undefined && agent.model !== undefined) {
    return `${agent.provider}/${agent.model}`;
  }
  return agent.model ?? agent.provider ?? "model not recorded";
}

/**
 * How many of these agents have each tool.
 *
 * Used to decide which of an agent's tools are worth the line. Almost every jazz agent can
 * read a file and run a command, so listing those first told somebody choosing between them
 * absolutely nothing — every row opened "cd, cp, edit_file, find, grep, ls" and the tools
 * that actually differ sat behind "+21 more".
 */
export function toolRarity(agents: readonly JazzAgent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    for (const tool of new Set(agent.tools)) {
      counts.set(tool, (counts.get(tool) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The tools that make this agent different, as many as fit.
 *
 * Rarest first, because "can this one search the web or reach my calendar" is the question
 * somebody choosing an agent for quartet is actually asking, and the answer is never in the
 * tools they all share. Ties break alphabetically so the order is stable between runs.
 */
export function describeTools(
  agent: JazzAgent,
  width: number,
  rarity: Map<string, number> = new Map(),
): string {
  if (agent.tools.length === 0) return "no tools";

  const ordered = [...agent.tools].sort((left, right) => {
    const byRarity = (rarity.get(left) ?? 0) - (rarity.get(right) ?? 0);
    return byRarity !== 0 ? byRarity : left.localeCompare(right);
  });

  const shown: string[] = [];
  let used = 0;
  for (const tool of ordered) {
    if (used + tool.length + 2 > width) break;
    shown.push(tool);
    used += tool.length + 2;
  }
  const rest = agent.tools.length - shown.length;
  if (shown.length === 0) return `${String(agent.tools.length)} tools`;
  return rest > 0 ? `${shown.join(", ")} +${String(rest)} more` : shown.join(", ");
}
