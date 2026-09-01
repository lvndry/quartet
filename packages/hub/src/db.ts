/**
 * @fileoverview Everything the hub remembers.
 *
 * SQLite rather than Postgres because the hub holds live WebSockets in memory: the socket
 * registry is already per-process state that cannot be shared across nodes without a pub/sub
 * layer, so a single process with a single file is the honest expression of the
 * architecture rather than a shortcut. Every read and write goes through this module so the
 * swap is real the day that stops being true.
 *
 * Two modelling choices are deliberate and cheap now, painful later:
 *
 * - **A person is a row, not a column.** One published agent per person is enforced in
 *   policy, not in the schema, so allowing several later is a policy change rather than a
 *   migration of every foreign key that pointed at an agent.
 * - **A connection is separate from a conversation.** An invite establishes the first;
 *   a purpose line opens the second. Conflating them would mean re-inviting somebody every
 *   time you wanted to talk about something new.
 */

import { Database } from "bun:sqlite";
import {
  DEFAULT_LIMIT,
  DEFAULT_TURN_BUDGET,
  type Limit,
  type Agent,
  type Connection,
  type Conversation,
  type Invite,
  type Message,
  type MessageKind,
} from "@quartet/protocol";

export interface AgentRow {
  id: string;
  owner_id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  token: string;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export class HubStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owners (
        id          TEXT PRIMARY KEY,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id            TEXT PRIMARY KEY,
        owner_id      TEXT NOT NULL REFERENCES owners(id),
        handle        TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL,
        bio           TEXT,
        token         TEXT NOT NULL UNIQUE,
        created_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connections (
        id          TEXT PRIMARY KEY,
        a_agent     TEXT NOT NULL REFERENCES agents(id),
        b_agent     TEXT NOT NULL REFERENCES agents(id),
        created_at  TEXT NOT NULL,
        UNIQUE (a_agent, b_agent)
      );

      CREATE TABLE IF NOT EXISTS invites (
        id          TEXT PRIMARY KEY,
        from_agent  TEXT NOT NULL REFERENCES agents(id),
        to_agent    TEXT NOT NULL REFERENCES agents(id),
        purpose     TEXT NOT NULL,
        status      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id             TEXT PRIMARY KEY,
        connection_id  TEXT NOT NULL REFERENCES connections(id),
        purpose        TEXT NOT NULL,
        budget         INTEGER NOT NULL,
        budget_max     INTEGER NOT NULL DEFAULT 6,
        limit_json     TEXT NOT NULL DEFAULT '{"kind":"turns","turns":6}',
        spent_usd      REAL NOT NULL DEFAULT 0,
        spend_incomplete INTEGER NOT NULL DEFAULT 0,
        stopped        INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        last_at        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id),
        author_agent     TEXT NOT NULL REFERENCES agents(id),
        kind             TEXT NOT NULL,
        text             TEXT NOT NULL,
        at               TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, at);
      CREATE INDEX IF NOT EXISTS idx_invites_to ON invites(to_agent, status);
    `);

    // `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a database created
    // before the ceiling was configurable needs the column added explicitly.
    const columns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(conversations)")
      .all()
      .map((column) => column.name);
    const added: Record<string, string> = {
      budget_max: `INTEGER NOT NULL DEFAULT ${String(DEFAULT_TURN_BUDGET)}`,
      limit_json: `TEXT NOT NULL DEFAULT '{"kind":"turns","turns":${String(DEFAULT_TURN_BUDGET)}}'`,
      spent_usd: "REAL NOT NULL DEFAULT 0",
      spend_incomplete: "INTEGER NOT NULL DEFAULT 0",
      stopped: "INTEGER NOT NULL DEFAULT 0",
    };
    for (const [column, definition] of Object.entries(added)) {
      if (!columns.includes(column)) {
        this.db.exec(`ALTER TABLE conversations ADD COLUMN ${column} ${definition}`);
      }
    }
  }

  /* ---------------- agents and people ---------------- */

  /**
   * Claim a handle, minting the person alongside the agent.
   *
   * Returns undefined when the handle is taken — the caller turns that into a message a
   * person can act on, rather than a constraint violation.
   */
  createAgent(input: {
    handle: string;
    displayName: string;
    bio?: string;
    token: string;
  }): AgentRow | undefined {
    if (this.agentByHandle(input.handle) !== undefined) return undefined;
    const ownerId = newId("own");
    const agentId = newId("agt");
    const at = nowIso();
    this.db.run("INSERT INTO owners (id, created_at) VALUES (?, ?)", [ownerId, at]);
    this.db.run(
      `INSERT INTO agents (id, owner_id, handle, display_name, bio, token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [agentId, ownerId, input.handle, input.displayName, input.bio ?? null, input.token, at],
    );
    return this.agentById(agentId);
  }

  agentByToken(token: string): AgentRow | undefined {
    return this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE token = ?").get(token) ?? undefined;
  }

  agentByHandle(handle: string): AgentRow | undefined {
    return this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE handle = ?").get(handle) ?? undefined;
  }

  agentById(id: string): AgentRow | undefined {
    return this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id) ?? undefined;
  }

  updateProfile(agentId: string, displayName: string, bio: string | undefined): void {
    this.db.run("UPDATE agents SET display_name = ?, bio = ? WHERE id = ?", [
      displayName,
      bio ?? null,
      agentId,
    ]);
  }

  allAgents(): AgentRow[] {
    return this.db.query<AgentRow, []>("SELECT * FROM agents ORDER BY created_at DESC").all();
  }

  /* ---------------- connections ---------------- */

  /** Connections are undirected; the pair is stored sorted so a duplicate cannot slip in. */
  private static pair(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
  }

  connectionBetween(a: string, b: string): { id: string; created_at: string } | undefined {
    const [x, y] = HubStore.pair(a, b);
    return (
      this.db
        .query<{ id: string; created_at: string }, [string, string]>(
          "SELECT id, created_at FROM connections WHERE a_agent = ? AND b_agent = ?",
        )
        .get(x, y) ?? undefined
    );
  }

  createConnection(a: string, b: string): string {
    const existing = this.connectionBetween(a, b);
    if (existing !== undefined) return existing.id;
    const [x, y] = HubStore.pair(a, b);
    const id = newId("con");
    this.db.run("INSERT INTO connections (id, a_agent, b_agent, created_at) VALUES (?, ?, ?, ?)", [
      id,
      x,
      y,
      nowIso(),
    ]);
    return id;
  }

  connectionsFor(agentId: string): { id: string; other: string; created_at: string }[] {
    return this.db
      .query<{ id: string; other: string; created_at: string }, [string, string, string]>(
        `SELECT id,
                CASE WHEN a_agent = ? THEN b_agent ELSE a_agent END AS other,
                created_at
         FROM connections WHERE a_agent = ? OR b_agent = ?`,
      )
      .all(agentId, agentId, agentId);
  }

  connectionParticipants(connectionId: string): [string, string] | undefined {
    const row = this.db
      .query<{ a_agent: string; b_agent: string }, [string]>(
        "SELECT a_agent, b_agent FROM connections WHERE id = ?",
      )
      .get(connectionId);
    return row ? [row.a_agent, row.b_agent] : undefined;
  }

  /* ---------------- invites ---------------- */

  createInvite(fromAgent: string, toAgent: string, purpose: string): Invite | undefined {
    const from = this.agentById(fromAgent);
    const to = this.agentById(toAgent);
    if (from === undefined || to === undefined) return undefined;
    const id = newId("inv");
    const at = nowIso();
    this.db.run(
      "INSERT INTO invites (id, from_agent, to_agent, purpose, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
      [id, fromAgent, toAgent, purpose, at],
    );
    return { id, fromHandle: from.handle, toHandle: to.handle, purpose, status: "pending", at };
  }

  inviteById(id: string): { id: string; from_agent: string; to_agent: string; purpose: string; status: string; created_at: string } | undefined {
    return (
      this.db
        .query<{ id: string; from_agent: string; to_agent: string; purpose: string; status: string; created_at: string }, [string]>(
          "SELECT * FROM invites WHERE id = ?",
        )
        .get(id) ?? undefined
    );
  }

  setInviteStatus(id: string, status: "accepted" | "declined"): void {
    this.db.run("UPDATE invites SET status = ? WHERE id = ?", [status, id]);
  }

  pendingInvitesFor(agentId: string): Invite[] {
    const rows = this.db
      .query<{ id: string; from_agent: string; to_agent: string; purpose: string; status: string; created_at: string }, [string, string]>(
        "SELECT * FROM invites WHERE (to_agent = ? OR from_agent = ?) AND status = 'pending' ORDER BY created_at DESC",
      )
      .all(agentId, agentId);
    return rows.flatMap((row) => {
      const from = this.agentById(row.from_agent);
      const to = this.agentById(row.to_agent);
      if (from === undefined || to === undefined) return [];
      return [
        {
          id: row.id,
          fromHandle: from.handle,
          toHandle: to.handle,
          purpose: row.purpose,
          status: "pending" as const,
          at: row.created_at,
        },
      ];
    });
  }

  /* ---------------- conversations and messages ---------------- */

  createConversation(
    connectionId: string,
    purpose: string,
    limit: Limit = DEFAULT_LIMIT,
  ): Conversation | undefined {
    const participants = this.connectionParticipants(connectionId);
    if (participants === undefined) return undefined;
    const id = newId("cnv");
    const at = nowIso();
    const turns = limit.kind === "turns" ? limit.turns : 0;
    this.db.run(
      "INSERT INTO conversations (id, connection_id, purpose, budget, budget_max, limit_json, created_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, connectionId, purpose, turns, turns, JSON.stringify(limit), at, at],
    );
    return this.conversation(id);
  }

  /** Parse a stored rule, falling back rather than throwing on a row written by an older build. */
  private static parseLimit(raw: string): Limit {
    try {
      const parsed = JSON.parse(raw) as Limit;
      if (parsed.kind === "turns" || parsed.kind === "cost" || parsed.kind === "none") return parsed;
    } catch {
      // Fall through to the default below.
    }
    return DEFAULT_LIMIT;
  }

  conversation(id: string): Conversation | undefined {
    const row = this.db
      .query<
        {
          id: string;
          connection_id: string;
          purpose: string;
          budget: number;
          budget_max: number;
          limit_json: string;
          spent_usd: number;
          spend_incomplete: number;
          stopped: number;
          last_at: string;
        },
        [string]
      >(
        "SELECT id, connection_id, purpose, budget, budget_max, limit_json, spent_usd, spend_incomplete, stopped, last_at FROM conversations WHERE id = ?",
      )
      .get(id);
    if (row === null || row === undefined) return undefined;
    const participants = this.connectionParticipants(row.connection_id);
    if (participants === undefined) return undefined;
    const handles = participants.flatMap((agentId) => {
      const agent = this.agentById(agentId);
      return agent ? [agent.handle] : [];
    });
    return {
      id: row.id,
      connectionId: row.connection_id,
      purpose: row.purpose,
      participants: handles,
      budgetRemaining: row.budget,
      limit: HubStore.parseLimit(row.limit_json),
      spentUSD: row.spent_usd,
      spendIncomplete: row.spend_incomplete === 1,
      stopped: row.stopped === 1,
      lastAt: row.last_at,
    };
  }

  conversationsFor(agentId: string): Conversation[] {
    const rows = this.db
      .query<{ id: string }, [string, string]>(
        `SELECT c.id FROM conversations c
         JOIN connections n ON n.id = c.connection_id
         WHERE n.a_agent = ? OR n.b_agent = ?
         ORDER BY c.last_at DESC`,
      )
      .all(agentId, agentId);
    return rows.flatMap((row) => {
      const conversation = this.conversation(row.id);
      return conversation ? [conversation] : [];
    });
  }

  /** Both agent ids in a conversation, so the hub knows who to wake and who to skip. */
  conversationParticipantIds(conversationId: string): [string, string] | undefined {
    const row = this.db
      .query<{ connection_id: string }, [string]>(
        "SELECT connection_id FROM conversations WHERE id = ?",
      )
      .get(conversationId);
    return row ? this.connectionParticipants(row.connection_id) : undefined;
  }

  appendMessage(input: {
    conversationId: string;
    authorAgentId: string;
    kind: MessageKind;
    text: string;
  }): Message | undefined {
    const author = this.agentById(input.authorAgentId);
    if (author === undefined) return undefined;
    const id = newId("msg");
    const at = nowIso();
    this.db.run(
      "INSERT INTO messages (id, conversation_id, author_agent, kind, text, at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, input.conversationId, input.authorAgentId, input.kind, input.text, at],
    );
    this.db.run("UPDATE conversations SET last_at = ? WHERE id = ?", [at, input.conversationId]);
    return {
      id,
      conversationId: input.conversationId,
      authorHandle: author.handle,
      kind: input.kind,
      text: input.text,
      at,
    };
  }

  /** The most recent `limit` messages, oldest first — the window an agent answers from. */
  transcript(conversationId: string, limit: number): Message[] {
    const rows = this.db
      .query<{ id: string; author_agent: string; kind: string; text: string; at: string }, [string, number]>(
        "SELECT id, author_agent, kind, text, at FROM messages WHERE conversation_id = ? ORDER BY at DESC, rowid DESC LIMIT ?",
      )
      .all(conversationId, limit);
    return rows
      .reverse()
      .flatMap((row) => {
        const author = this.agentById(row.author_agent);
        if (author === undefined) return [];
        return [
          {
            id: row.id,
            conversationId,
            authorHandle: author.handle,
            kind: row.kind as MessageKind,
            text: row.text,
            at: row.at,
          },
        ];
      });
  }

  setBudget(conversationId: string, remaining: number): void {
    this.db.run("UPDATE conversations SET budget = ? WHERE id = ?", [remaining, conversationId]);
  }

  /**
   * Change the spending rule.
   *
   * Tops the remaining turns up to the new ceiling, so a conversation that has just gone
   * quiet becomes usable again the moment the limit is raised rather than after one more
   * nudge. Under a cost or unlimited rule the turn counter stops meaning anything.
   */
  setLimit(conversationId: string, limit: Limit): void {
    // Changing the rule un-stops the conversation: picking a new allowance is how you say
    // "carry on", and making somebody clear a separate flag as well would be a puzzle.
    const turns = limit.kind === "turns" ? limit.turns : 0;
    this.db.run(
      "UPDATE conversations SET limit_json = ?, budget_max = ?, budget = MAX(budget, ?), stopped = 0 WHERE id = ?",
      [JSON.stringify(limit), turns, turns, conversationId],
    );
  }

  /**
   * Halt or resume a conversation without touching its rule.
   *
   * A separate flag rather than a zeroed budget: stopping must not quietly rewrite the
   * allowance somebody chose, and under a cost or unlimited rule there is no turn counter to
   * zero in the first place.
   */
  setStopped(conversationId: string, stopped: boolean): void {
    this.db.run("UPDATE conversations SET stopped = ? WHERE id = ?", [
      stopped ? 1 : 0,
      conversationId,
    ]);
  }

  isStopped(conversationId: string): boolean {
    const row = this.db
      .query<{ stopped: number }, [string]>("SELECT stopped FROM conversations WHERE id = ?")
      .get(conversationId);
    return row?.stopped === 1;
  }

  limitFor(conversationId: string): Limit {
    const row = this.db
      .query<{ limit_json: string }, [string]>("SELECT limit_json FROM conversations WHERE id = ?")
      .get(conversationId);
    return row === null || row === undefined ? DEFAULT_LIMIT : HubStore.parseLimit(row.limit_json);
  }

  budgetMax(conversationId: string): number {
    const row = this.db
      .query<{ budget_max: number }, [string]>(
        "SELECT budget_max FROM conversations WHERE id = ?",
      )
      .get(conversationId);
    return row?.budget_max ?? DEFAULT_TURN_BUDGET;
  }

  /** Add one turn's reported cost. `incomplete` latches: once unpriced, the total is a floor. */
  addSpend(conversationId: string, costUSD: number, incomplete: boolean): void {
    this.db.run(
      "UPDATE conversations SET spent_usd = spent_usd + ?, spend_incomplete = MAX(spend_incomplete, ?) WHERE id = ?",
      [costUSD, incomplete ? 1 : 0, conversationId],
    );
  }

  spend(conversationId: string): { usd: number; incomplete: boolean } {
    const row = this.db
      .query<{ spent_usd: number; spend_incomplete: number }, [string]>(
        "SELECT spent_usd, spend_incomplete FROM conversations WHERE id = ?",
      )
      .get(conversationId);
    return { usd: row?.spent_usd ?? 0, incomplete: row?.spend_incomplete === 1 };
  }

  budget(conversationId: string): number {
    const row = this.db
      .query<{ budget: number }, [string]>("SELECT budget FROM conversations WHERE id = ?")
      .get(conversationId);
    return row?.budget ?? 0;
  }

  /* ---------------- projections ---------------- */

  toAgent(row: AgentRow, online: boolean): Agent {
    return {
      id: row.id,
      handle: row.handle,
      displayName: row.display_name,
      ...(row.bio !== null ? { bio: row.bio } : {}),
      ownerId: row.owner_id,
      online,
    };
  }

  toConnection(
    id: string,
    otherAgentId: string,
    since: string,
    online: (agentId: string) => boolean,
  ): Connection | undefined {
    const other = this.agentById(otherAgentId);
    if (other === undefined) return undefined;
    return { id, withAgent: this.toAgent(other, online(otherAgentId)), since };
  }
}
