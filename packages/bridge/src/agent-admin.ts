/**
 * @fileoverview This machine's jazz agents as the app sees them, and the operations on them.
 *
 * One place that knows the current roster, so the browser never has to. The web UI holds the
 * daemon's address and token nowhere: it posts to the local app, this asks jazz, and the
 * answer arrives in the next state snapshot. That is the same boundary the daemon token has
 * always had — it wakes an agent with filesystem access and must not leave this process.
 *
 * Deliberately not a second rulebook. Every refusal comes back from jazz with the field it
 * concerns, and is passed through untouched.
 */

import type { DaemonSettings } from "./config";
import { describeModel, fetchJazzAgents, type JazzAgent } from "./jazz-agents";
import {
  createJazzAgent,
  deleteJazzAgent,
  fetchJazzAgentDetail,
  fetchJazzCatalog,
  fetchJazzModels,
  fetchJazzPersonas,
  fetchJazzTools,
  updateJazzAgent,
  type JazzAgentConfig,
  type JazzAgentDetail,
  type JazzCatalog,
  type JazzModel,
  type JazzPersona,
  type JazzResult,
  type JazzTools,
} from "./jazz-admin";
import { agentIdFor, ensureJazzWebhook } from "./jazz";
import { logger } from "./log";

const log = logger("agents");

/** Why the roster could not be read, in the terms the UI has to say something about. */
export type JazzProblem = "unreachable" | "unauthorized" | "unsupported" | "failed";

export interface JazzRoster {
  readonly agents: readonly JazzAgent[];
  /** The agent quartet speaks as, per jazz's webhook entry. */
  readonly myAgentId?: string;
  readonly problem?: JazzProblem;
  /**
   * The menus an editor is built from, absent when this jazz is too old to serve them.
   *
   * Absent therefore means "listing and switching work, editing does not" — which is worth
   * distinguishing, because a dashboard that hid itself entirely would take away the one
   * thing an old jazz can still do.
   */
  readonly catalog?: JazzCatalog;
}

export class AgentAdmin {
  private roster: JazzRoster = { agents: [] };

  constructor(
    private readonly daemon: DaemonSettings,
    private readonly onChange: (roster: JazzRoster) => void,
  ) {}

  current(): JazzRoster {
    return this.roster;
  }

  /**
   * Re-read everything the roster is made of.
   *
   * Called at startup and after every mutation rather than patching the local copy: jazz is
   * the one that knows, and a create can change more than the row it added — a rename
   * reshuffles the sort, and a delete can leave the webhook pointing at nothing.
   */
  async refresh(): Promise<JazzRoster> {
    const [listing, catalog, myAgentId] = await Promise.all([
      fetchJazzAgents(this.daemon.url, this.daemon.token),
      fetchJazzCatalog(this.daemon),
      agentIdFor(this.daemon.webhook),
    ]);

    const next: JazzRoster = {
      agents: listing.kind === "ok" ? listing.agents : [],
      ...(myAgentId !== undefined ? { myAgentId } : {}),
      ...(listing.kind !== "ok" ? { problem: listing.kind } : {}),
      ...(catalog.kind === "ok" ? { catalog: catalog.value } : {}),
    };

    if (listing.kind !== "ok") {
      log.warn(`could not read jazz's agents: ${listing.kind}`);
    } else if (catalog.kind === "unsupported") {
      log.info("this jazz has no /catalog — agents can be listed and switched, not edited");
    }

    this.roster = next;
    this.onChange(next);
    return next;
  }

  /** `provider/model` for the agent that speaks here, when jazz will say. */
  myModel(): string | undefined {
    const mine = this.roster.agents.find((agent) => agent.id === this.roster.myAgentId);
    return mine === undefined ? undefined : describeModel(mine);
  }

  detail(identifier: string): Promise<JazzResult<JazzAgentDetail>> {
    return fetchJazzAgentDetail(this.daemon, identifier);
  }

  models(provider: string, capability?: string): Promise<JazzResult<readonly JazzModel[]>> {
    return capability === undefined
      ? fetchJazzModels(this.daemon, provider)
      : fetchJazzModels(this.daemon, provider, capability);
  }

  personas(): Promise<JazzResult<readonly JazzPersona[]>> {
    return fetchJazzPersonas(this.daemon);
  }

  tools(): Promise<JazzResult<JazzTools>> {
    return fetchJazzTools(this.daemon);
  }

  async create(draft: {
    readonly name: string;
    readonly description?: string;
    readonly config: JazzAgentConfig;
  }): Promise<JazzResult<JazzAgentDetail>> {
    const created = await createJazzAgent(this.daemon, draft);
    if (created.kind === "ok") await this.refresh();
    return created;
  }

  async update(
    identifier: string,
    changes: {
      readonly name?: string;
      readonly description?: string;
      readonly config?: JazzAgentConfig;
    },
  ): Promise<JazzResult<JazzAgentDetail>> {
    const updated = await updateJazzAgent(this.daemon, identifier, changes);
    if (updated.kind === "ok") await this.refresh();
    return updated;
  }

  /**
   * Delete an agent, refusing to delete the one that speaks for you.
   *
   * Not jazz's business to refuse — jazz has no idea quartet points a webhook at it — and
   * removing it would leave the webhook naming an agent that does not exist, which is
   * precisely the failure mode that has no symptom until a turn silently stops working.
   * Switch first, then delete.
   */
  async remove(identifier: string): Promise<JazzResult<string>> {
    const mine = this.roster.agents.find((agent) => agent.id === this.roster.myAgentId);
    if (mine !== undefined && (identifier === mine.id || identifier === mine.name)) {
      return {
        kind: "rejected",
        error: `${mine.name} is the agent that speaks for you here`,
        suggestion: "Switch to a different agent first, then delete this one.",
      };
    }
    const removed = await deleteJazzAgent(this.daemon, identifier);
    if (removed.kind === "ok") await this.refresh();
    return removed;
  }

  /**
   * Point quartet's webhook at a different agent.
   *
   * Checked against the roster first. A webhook naming an agent that does not exist is
   * written happily by jazz and says nothing until turns start failing, long after this
   * looked like it worked — which is the same trap the old free-text setup prompt fell into.
   */
  async select(agentId: string): Promise<JazzResult<string>> {
    const chosen = this.roster.agents.find(
      (agent) => agent.id === agentId || agent.name === agentId,
    );
    if (chosen === undefined) {
      return {
        kind: "rejected",
        error: `no agent here is called "${agentId}"`,
        field: "agentId",
      };
    }

    await ensureJazzWebhook({ webhookName: this.daemon.webhook, agentId: chosen.id });
    await this.refresh();
    return { kind: "ok", value: chosen.id };
  }
}
