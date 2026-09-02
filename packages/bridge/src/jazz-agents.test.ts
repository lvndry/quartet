import { describe, expect, it } from "bun:test";
import {
  describeModel,
  describeTools,
  fetchJazzAgents,
  resolveAgentChoice,
  toolRarity,
  type JazzAgent,
} from "./jazz-agents";

function agent(over: Partial<JazzAgent> = {}): JazzAgent {
  return { id: "agt_1", name: "sonnet", tools: [], ...over };
}

/** A stand-in daemon, so none of this depends on one being installed. */
function daemon(handler: (request: Request) => Response): { url: string; stop: () => void } {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  return { url: `http://127.0.0.1:${String(server.port)}`, stop: () => server.stop(true) };
}

describe("asking the daemon which agents it has", () => {
  it("reads the list it answers with", async () => {
    const stub = daemon(() =>
      Response.json({
        ok: true,
        agents: [
          { id: "b", name: "zeta", provider: "openai", model: "gpt-5.4-mini", tools: ["ls"] },
          { id: "a", name: "alpha", provider: "anthropic", model: "claude-sonnet-4-6", persona: "default", tools: [] },
        ],
      }),
    );
    const listing = await fetchJazzAgents(stub.url);
    stub.stop();

    expect(listing.kind).toBe("ok");
    if (listing.kind !== "ok") return;
    // Sorted by name, because the list is printed for somebody to read.
    expect(listing.agents.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
    expect(listing.agents[1]).toEqual({
      id: "b",
      name: "zeta",
      provider: "openai",
      model: "gpt-5.4-mini",
      tools: ["ls"],
    });
  });

  it("says the daemon is not running rather than that there are no agents", async () => {
    // Nothing is listening on this port. The two are different problems with different fixes.
    const listing = await fetchJazzAgents("http://127.0.0.1:1");
    expect(listing.kind).toBe("unreachable");
  });

  it("distinguishes a daemon that wants a token", async () => {
    const stub = daemon(() => Response.json({ ok: false, error: "unauthorized" }, { status: 401 }));
    const listing = await fetchJazzAgents(stub.url);
    stub.stop();
    expect(listing.kind).toBe("unauthorized");
  });

  it("distinguishes a jazz too old to have the route", async () => {
    const stub = daemon(() => Response.json({ ok: false, error: "not found" }, { status: 404 }));
    const listing = await fetchJazzAgents(stub.url);
    stub.stop();
    expect(listing.kind).toBe("unsupported");
  });

  it("treats a body with no agents array as an answer it cannot use", async () => {
    const stub = daemon(() => Response.json({ ok: true }));
    const listing = await fetchJazzAgents(stub.url);
    stub.stop();
    expect(listing.kind).toBe("unsupported");
  });

  it("skips an entry it cannot make sense of rather than dropping the list", async () => {
    const stub = daemon(() =>
      Response.json({ ok: true, agents: [{ name: "no id" }, { id: "a", name: "alpha" }] }),
    );
    const listing = await fetchJazzAgents(stub.url);
    stub.stop();

    expect(listing.kind).toBe("ok");
    if (listing.kind !== "ok") return;
    expect(listing.agents.map((entry) => entry.name)).toEqual(["alpha"]);
    expect(listing.agents[0]?.tools).toEqual([]);
  });

  it("sends the token when it has one", async () => {
    let seen: string | undefined;
    const stub = daemon((request) => {
      seen = request.headers.get("authorization") ?? undefined;
      return Response.json({ ok: true, agents: [] });
    });
    await fetchJazzAgents(stub.url, "s3cret");
    stub.stop();
    expect(seen).toBe("Bearer s3cret");
  });
});

describe("picking one from the list", () => {
  const agents = [agent({ id: "a", name: "alpha" }), agent({ id: "b", name: "mini-coder" })];

  it("takes the number as printed", () => {
    expect(resolveAgentChoice(agents, "2")?.id).toBe("b");
  });

  it("takes a name, case-insensitively, because that is what people read off the list", () => {
    expect(resolveAgentChoice(agents, "Mini-Coder")?.id).toBe("b");
  });

  it("takes an id", () => {
    expect(resolveAgentChoice(agents, "a")?.id).toBe("a");
  });

  it("prefers a name over an id when one string is both", () => {
    const collide = [agent({ id: "zzz", name: "b" }), agent({ id: "b", name: "other" })];
    expect(resolveAgentChoice(collide, "b")?.id).toBe("zzz");
  });

  it("refuses a number off the end of the list", () => {
    expect(resolveAgentChoice(agents, "3")).toBeUndefined();
    expect(resolveAgentChoice(agents, "0")).toBeUndefined();
  });

  it("refuses the old bogus default instead of accepting it", () => {
    // "default" is a persona name in jazz. Accepting it wrote a webhook nothing could run.
    expect(resolveAgentChoice(agents, "default")).toBeUndefined();
    expect(resolveAgentChoice(agents, "")).toBeUndefined();
  });
});

describe("describing an agent", () => {
  it("pairs provider with model", () => {
    expect(describeModel(agent({ provider: "openai", model: "gpt-5.4-mini" }))).toBe(
      "openai/gpt-5.4-mini",
    );
  });

  it("says what it knows when only one half is recorded", () => {
    expect(describeModel(agent({ model: "gpt-5.4-mini" }))).toBe("gpt-5.4-mini");
    expect(describeModel(agent({ provider: "ollama" }))).toBe("ollama");
    expect(describeModel(agent())).toBe("model not recorded");
  });

  it("leads with the tools that tell agents apart, not the ones they all share", () => {
    // Every jazz agent can read a file. Listing that first told a chooser nothing at all.
    const shared = ["ls", "read_file", "write_file"];
    const agents = [
      agent({ name: "plain", tools: shared }),
      agent({ name: "connected", tools: [...shared, "http_request", "web_search"] }),
    ];
    const rarity = toolRarity(agents);

    const described = describeTools(agents[1] as JazzAgent, 40, rarity);
    expect(described.startsWith("http_request")).toBe(true);
    expect(described).toContain("web_search");
  });

  it("says so when an agent has no tools", () => {
    expect(describeTools(agent(), 40)).toBe("no tools");
  });

  it("keeps within the width it is given, and counts what it left out", () => {
    const many = agent({ tools: Array.from({ length: 30 }, (_u, i) => `tool_${String(i)}`) });
    const described = describeTools(many, 40);

    expect(described.length).toBeLessThanOrEqual(40 + " +99 more".length);
    expect(described).toContain("more");
  });
})
