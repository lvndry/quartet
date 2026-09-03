import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentAdmin, type JazzRoster } from "./agent-admin";
import type { DaemonSettings } from "./config";

const AGENTS = [
  { id: "agt_sonnet", name: "sonnet", provider: "anthropic", model: "claude-sonnet-4-6", tools: [] },
  { id: "agt_scratch", name: "scratch", provider: "openai", model: "gpt-5.4-mini", tools: [] },
];

const CATALOG = {
  ok: true,
  providers: ["openai", "anthropic"],
  webSearchProviders: ["exa"],
  reasoningEfforts: ["disable", "low", "medium", "high"],
};

/** A stand-in daemon, so none of this depends on jazz being installed. */
function daemon(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  return { url: `http://127.0.0.1:${String(server.port)}`, stop: () => server.stop(true) };
}

/** Answers the routes a healthy, current jazz would. */
function healthyDaemon(overrides: Record<string, () => Response> = {}) {
  return daemon((request) => {
    const path = new URL(request.url).pathname;
    const key = `${request.method} ${path}`;
    const override = overrides[key];
    if (override !== undefined) return override();
    if (key === "GET /agents") return Response.json({ ok: true, agents: AGENTS });
    if (key === "GET /catalog") return Response.json(CATALOG);
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  });
}

let jazzHome: string;
let previousJazzHome: string | undefined;

beforeEach(async () => {
  jazzHome = await mkdtemp(join(tmpdir(), "quartet-agents-"));
  previousJazzHome = process.env["JAZZ_HOME"];
  process.env["JAZZ_HOME"] = jazzHome;
  // The webhook entry is what actually decides which agent speaks for this machine, so the
  // roster reads it from jazz's config rather than keeping a second copy.
  await writeFile(
    join(jazzHome, "config.json"),
    JSON.stringify({
      webhooks: [
        { name: "quartet", agentId: "agt_sonnet", promptTemplate: "{{payload}}" },
      ],
    }),
  );
});

afterEach(() => {
  if (previousJazzHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = previousJazzHome;
});

function settings(url: string): DaemonSettings {
  return { url, webhook: "quartet", token: "daemon-token" };
}

function adminFor(url: string): { admin: AgentAdmin; published: JazzRoster[] } {
  const published: JazzRoster[] = [];
  const admin = new AgentAdmin(settings(url), (roster) => published.push(roster));
  return { admin, published };
}

async function webhookAgentId(): Promise<string | undefined> {
  const raw = await readFile(join(jazzHome, "config.json"), "utf8");
  const config = JSON.parse(raw) as { webhooks?: { name: string; agentId: string }[] };
  return config.webhooks?.find((entry) => entry.name === "quartet")?.agentId;
}

describe("reading the roster", () => {
  it("reports the agents, which one speaks here, and the menus", async () => {
    const stub = healthyDaemon();
    try {
      const { admin, published } = adminFor(stub.url);
      const roster = await admin.refresh();

      expect(roster.agents.map((agent) => agent.name)).toEqual(["scratch", "sonnet"]);
      expect(roster.myAgentId).toBe("agt_sonnet");
      expect(roster.catalog?.providers).toEqual(["openai", "anthropic"]);
      expect(roster.problem).toBeUndefined();
      // Published so the browser learns about it without asking.
      expect(published).toHaveLength(1);
    } finally {
      stub.stop();
    }
  });

  it("resolves a webhook that names its agent rather than identifying it", async () => {
    // `quartet connect --agent sonnet` writes the flag through verbatim, and jazz resolves a
    // name the same as an id — so this config is correct, and the roster has to agree with it
    // or nothing shows as speaking for you and the header claims no model at all.
    await writeFile(
      join(jazzHome, "config.json"),
      JSON.stringify({
        webhooks: [{ name: "quartet", agentId: "sonnet", promptTemplate: "{{payload}}" }],
      }),
    );
    const stub = healthyDaemon();
    try {
      const { admin } = adminFor(stub.url);
      const roster = await admin.refresh();

      expect(roster.myAgentId).toBe("agt_sonnet");
      expect(admin.myModel()).toBe("anthropic/claude-sonnet-4-6");
    } finally {
      stub.stop();
    }
  });

  it("keeps an unresolvable webhook agent as it found it", async () => {
    // Nothing to resolve it against is not the same as resolving it to nothing: overwriting
    // would lose the only record of what the webhook actually points at.
    await writeFile(
      join(jazzHome, "config.json"),
      JSON.stringify({
        webhooks: [{ name: "quartet", agentId: "agt_ghost", promptTemplate: "{{payload}}" }],
      }),
    );
    const stub = healthyDaemon();
    try {
      const { admin } = adminFor(stub.url);
      const roster = await admin.refresh();

      expect(roster.myAgentId).toBe("agt_ghost");
      expect(admin.myModel()).toBeUndefined();
    } finally {
      stub.stop();
    }
  });

  it("derives the running model from whichever agent speaks here", async () => {
    const stub = healthyDaemon();
    try {
      const { admin } = adminFor(stub.url);
      await admin.refresh();
      expect(admin.myModel()).toBe("anthropic/claude-sonnet-4-6");
    } finally {
      stub.stop();
    }
  });

  it("still lists agents when this jazz is too old to serve the menus", async () => {
    // The degradation that matters: an old jazz can be listed and switched between, just not
    // edited. Hiding the dashboard entirely would take away the one thing it can still do.
    const stub = healthyDaemon({
      "GET /catalog": () => Response.json({ ok: false, error: "not found" }, { status: 404 }),
    });
    try {
      const { admin } = adminFor(stub.url);
      const roster = await admin.refresh();

      expect(roster.agents).toHaveLength(2);
      expect(roster.catalog).toBeUndefined();
      expect(roster.problem).toBeUndefined();
    } finally {
      stub.stop();
    }
  });

  it("says the daemon is not answering rather than that there are no agents", async () => {
    const { admin } = adminFor("http://127.0.0.1:1");
    const roster = await admin.refresh();

    expect(roster.problem).toBe("unreachable");
    expect(roster.agents).toEqual([]);
  });
});

describe("choosing which agent speaks here", () => {
  it("writes the webhook and adopts the new agent", async () => {
    const stub = healthyDaemon();
    try {
      const { admin } = adminFor(stub.url);
      await admin.refresh();

      const result = await admin.select("agt_scratch");
      expect(result.kind).toBe("ok");
      expect(await webhookAgentId()).toBe("agt_scratch");
      expect(admin.current().myAgentId).toBe("agt_scratch");
      expect(admin.myModel()).toBe("openai/gpt-5.4-mini");
    } finally {
      stub.stop();
    }
  });

  it("takes a name as well as an id, because that is what a person reads", async () => {
    const stub = healthyDaemon();
    try {
      const { admin } = adminFor(stub.url);
      await admin.refresh();
      expect((await admin.select("scratch")).kind).toBe("ok");
      expect(await webhookAgentId()).toBe("agt_scratch");
    } finally {
      stub.stop();
    }
  });

  it("refuses an agent that does not exist, and leaves the webhook alone", async () => {
    // jazz writes a webhook naming a missing agent perfectly happily and says nothing until
    // turns start failing, long after this looked like it worked.
    const stub = healthyDaemon();
    try {
      const { admin } = adminFor(stub.url);
      await admin.refresh();

      const result = await admin.select("agt_ghost");
      expect(result.kind).toBe("rejected");
      expect(await webhookAgentId()).toBe("agt_sonnet");
    } finally {
      stub.stop();
    }
  });
});

describe("deleting an agent", () => {
  it("refuses to delete the one that speaks for you", async () => {
    // Not jazz's business to refuse: it has no idea quartet points a webhook at it. Deleting
    // it would leave the webhook naming nothing, which has no symptom until a turn fails.
    let deleteCalls = 0;
    const stub = healthyDaemon({
      "DELETE /agents/agt_sonnet": () => {
        deleteCalls += 1;
        return Response.json({ ok: true, id: "agt_sonnet" });
      },
    });
    try {
      const { admin } = adminFor(stub.url);
      await admin.refresh();

      const result = await admin.remove("agt_sonnet");
      expect(result.kind).toBe("rejected");
      expect(deleteCalls).toBe(0);
    } finally {
      stub.stop();
    }
  });

  it("refuses it by name too, not just by id", async () => {
    const stub = healthyDaemon();
    try {
      const { admin } = adminFor(stub.url);
      await admin.refresh();
      expect((await admin.remove("sonnet")).kind).toBe("rejected");
    } finally {
      stub.stop();
    }
  });

  it("deletes any other agent", async () => {
    const stub = healthyDaemon({
      "DELETE /agents/agt_scratch": () => Response.json({ ok: true, id: "agt_scratch" }),
    });
    try {
      const { admin } = adminFor(stub.url);
      await admin.refresh();
      expect(await admin.remove("agt_scratch")).toEqual({ kind: "ok", value: "agt_scratch" });
    } finally {
      stub.stop();
    }
  });
});

describe("creating and editing", () => {
  it("passes jazz's refusal through with the field it names", async () => {
    // The reason the form can mark the offending input instead of showing a banner.
    const stub = healthyDaemon({
      "POST /agents": () =>
        Response.json(
          {
            ok: false,
            error: 'Unknown LLM provider "gpt"',
            field: "config.llmProvider",
            suggestion: "Use one of: openai, anthropic.",
          },
          { status: 400 },
        ),
    });
    try {
      const { admin } = adminFor(stub.url);
      await admin.refresh();

      const result = await admin.create({
        name: "broken",
        config: { persona: "default", llmProvider: "gpt", llmModel: "x" },
      });
      expect(result).toMatchObject({
        kind: "rejected",
        field: "config.llmProvider",
        suggestion: "Use one of: openai, anthropic.",
      });
    } finally {
      stub.stop();
    }
  });

  it("re-reads the roster after a create, rather than patching its copy", async () => {
    // A create can change more than the row it added: a name reshuffles the sort order.
    const stub = healthyDaemon({
      "POST /agents": () =>
        Response.json({
          ok: true,
          agent: {
            id: "agt_new",
            name: "new",
            persona: "default",
            provider: "openai",
            model: "gpt-5.4-mini",
            tools: [],
            config: { persona: "default", llmProvider: "openai", llmModel: "gpt-5.4-mini" },
            apiKeyProviders: [],
          },
        }),
    });
    try {
      const { admin, published } = adminFor(stub.url);
      await admin.refresh();
      const before = published.length;

      const result = await admin.create({
        name: "new",
        config: { persona: "default", llmProvider: "openai", llmModel: "gpt-5.4-mini" },
      });
      expect(result.kind).toBe("ok");
      expect(published.length).toBeGreaterThan(before);
    } finally {
      stub.stop();
    }
  });
});
