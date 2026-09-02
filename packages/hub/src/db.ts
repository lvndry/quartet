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
import type { InFlight } from "./turn-policy";
import {
  DEFAULT_LIMIT,
  DEFAULT_TURN_BUDGET,
  limitSchema,
  roomStateSchema,
  TURN_SLICE_MAX,
  WELCOME_TRANSCRIPT_WINDOW,
  type Limit,
  type RoomState,
  type Agent,
  type Connection,
  type Conversation,
  type Invite,
  type Message,
  type MessageKind,
  type Signature,
} from "@quartet/protocol";

export interface AgentRow {
  id: string;
  owner_id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  token: string;
  /** Null on agents claimed before keys existed. They still work; they just prove nothing. */
  did: string | null;
  created_at: string;
}

/** One message with its author's handle already resolved. See `MESSAGE_SELECT`. */
interface MessageRow {
  id: string;
  conversation_id: string;
  handle: string;
  kind: string;
  text: string;
  at: string;
  sig_did: string | null;
  sig_at: string | null;
  sig_nonce: string | null;
  sig_prev: string | null;
  sig_value: string | null;
}

/**
 * The projection every transcript read shares.
 *
 * One string so the two readers cannot drift into selecting different columns and then
 * disagreeing about what a message is. The join also decides what happens to a message
 * whose author has been deleted: it disappears, which is what the per-row lookup this
 * replaced did too.
 */
const MESSAGE_SELECT = `SELECT m.id, m.conversation_id, a.handle, m.kind, m.text, m.at,
            m.sig_did, m.sig_at, m.sig_nonce, m.sig_prev, m.sig_value
     FROM messages m
     JOIN agents a ON a.id = m.author_agent`;

/**
 * What counts as an agent having had its say: its own words, or its own deliberate silence.
 *
 * Deliberately not "any message attributed to this agent". A system note is the room
 * talking about itself, and it is attributed to whoever's action provoked it — so a failed
 * turn writes a `trouble` note in the agent's own name, and counting that as an answer meant
 * the retry was suppressed and the message was never answered by anybody. The same
 * reasoning decides where an agent's next turn starts reading from, so both use this.
 */
const OWN_UTTERANCE = "m.kind IN ('agent', 'pass')";

interface InviteRow {
  id: string;
  from_agent: string;
  to_agent: string;
  purpose: string;
  status: string;
  created_at: string;
  limit_json: string | null;
}

/**
 * Reassemble a stored signature, or nothing at all.
 *
 * All-or-nothing on purpose. A row with some of the columns filled is a hub that has been
 * edited underneath itself, and handing back a half-built signature would turn that into a
 * verification failure on somebody's screen — which reads as "your correspondent is lying"
 * rather than "this hub's database is damaged".
 */
function signatureOf(row: MessageRow): Signature | undefined {
  const { sig_did, sig_at, sig_nonce, sig_prev, sig_value } = row;
  if (sig_did === null || sig_at === null || sig_nonce === null) return undefined;
  if (sig_prev === null || sig_value === null) return undefined;
  return {
    did: sig_did,
    authoredAt: sig_at,
    nonce: sig_nonce,
    prev: sig_prev,
    value: sig_value,
  };
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
        created_at  TEXT NOT NULL,
        limit_json  TEXT NOT NULL DEFAULT '{"kind":"turns","turns":50}'
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id             TEXT PRIMARY KEY,
        connection_id  TEXT NOT NULL REFERENCES connections(id),
        purpose        TEXT NOT NULL,
        budget         INTEGER NOT NULL,
        budget_max     INTEGER NOT NULL DEFAULT 50,
        limit_json     TEXT NOT NULL DEFAULT '{"kind":"turns","turns":50}',
        spent_usd      REAL NOT NULL DEFAULT 0,
        spend_incomplete INTEGER NOT NULL DEFAULT 0,
        state          TEXT NOT NULL DEFAULT 'live',
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

      -- Who is in a room.
      --
      -- Membership used to be read off the room's connection, which is a pair by
      -- definition, so every room was two people whatever anyone wanted. A connection is
      -- still a pair — it is a relationship between two people and that is the right
      -- model — but it is now only where a room started, not who is in it.
      CREATE TABLE IF NOT EXISTS conversation_members (
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        agent_id        TEXT NOT NULL REFERENCES agents(id),
        joined_at       TEXT NOT NULL,
        -- When this member's agent said goodbye. Durable, because a hub restart must not
        -- resurrect an agent whose owner is no longer paying for it to talk.
        bowed_out_at    TEXT,
        PRIMARY KEY (conversation_id, agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_members_agent ON conversation_members(agent_id);

      -- Turns the hub has charged for and is waiting on.
      --
      -- Durable because the charge is: the budget is written to disk at dispatch, so a hub
      -- restart used to leave a conversation paid up and silent, with no in-flight entry to
      -- replay, no deadline left to fire, and nothing in the transcript saying why it had
      -- gone quiet. Orchestrator.recover reads these back at boot.
      CREATE TABLE IF NOT EXISTS turns_in_flight (
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        agent_id        TEXT NOT NULL REFERENCES agents(id),
        dispatched_at   TEXT NOT NULL,
        pending         INTEGER NOT NULL DEFAULT 0,
        steered         INTEGER NOT NULL DEFAULT 0,
        queued_steer    TEXT,
        dispatch_steer  TEXT,
        PRIMARY KEY (conversation_id, agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, at);
      -- Serves owesTurn, which asks who spoke last rather than what was said. Without it
      -- that answer costs a scan of every message in the room, on every event.
      CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(conversation_id, author_agent);
      CREATE INDEX IF NOT EXISTS idx_invites_to ON invites(to_agent, status);
    `);

    // `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a database created
    // before the ceiling was configurable needs the column added explicitly. Read once,
    // before any of them are added, because the backfill below turns on what was *missing*.
    const conversationColumns = this.columnsOf("conversations");
    this.addMissingColumns("conversations", {
      budget_max: `INTEGER NOT NULL DEFAULT ${String(DEFAULT_TURN_BUDGET)}`,
      limit_json: `TEXT NOT NULL DEFAULT '{"kind":"turns","turns":${String(DEFAULT_TURN_BUDGET)}}'`,
      spent_usd: "REAL NOT NULL DEFAULT 0",
      spend_incomplete: "INTEGER NOT NULL DEFAULT 0",
      state: "TEXT NOT NULL DEFAULT 'live'",
    });

    // A database written before rooms had three states carries one `stopped` flag, which
    // cannot say whether a person halted the room or an agent said goodbye. `halted` is the
    // safe reading of the two: it is the one a person can lift by carrying on, so a
    // misread costs a conversation nothing. The old column is left where it is — SQLite
    // makes dropping one a table rewrite, and nothing reads it now.
    if (!conversationColumns.includes("state") && conversationColumns.includes("stopped")) {
      this.db.exec("UPDATE conversations SET state = 'halted' WHERE stopped = 1");
    }

    // Rooms written before membership was its own table have theirs implied by their
    // connection. Seeding from that is exact rather than a guess: a two-party room's members
    // were precisely the two ends of the pair it came from.
    this.addMissingColumns("conversation_members", { bowed_out_at: "TEXT" });

    this.db.exec(`
      INSERT OR IGNORE INTO conversation_members (conversation_id, agent_id, joined_at)
      SELECT c.id, n.a_agent, c.created_at FROM conversations c
        JOIN connections n ON n.id = c.connection_id;
      INSERT OR IGNORE INTO conversation_members (conversation_id, agent_id, joined_at)
      SELECT c.id, n.b_agent, c.created_at FROM conversations c
        JOIN connections n ON n.id = c.connection_id;
    `);

    this.addMissingColumns("invites", {
      limit_json: `TEXT NOT NULL DEFAULT '{"kind":"turns","turns":${String(DEFAULT_TURN_BUDGET)}}'`,
    });

    // Nullable, because a hub that predates signing still has agents that never presented a
    // key, and they keep working. Unique through a partial index rather than a column
    // constraint: SQLite cannot add UNIQUE in an ALTER, and NULLs must stay free to collide.
    this.addMissingColumns("agents", { did: "TEXT" });

    // The signature is stored in pieces rather than as a JSON blob so that a hub cannot be
    // the thing that reshapes it. It goes out exactly as it came in.
    this.addMissingColumns("messages", {
      sig_did: "TEXT",
      sig_at: "TEXT",
      sig_nonce: "TEXT",
      sig_prev: "TEXT",
      sig_value: "TEXT",
    });

    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_did ON agents(did) WHERE did IS NOT NULL",
    );
  }

  private columnsOf(table: string): string[] {
    return this.db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name);
  }

  private addMissingColumns(table: string, definitions: Record<string, string>): void {
    const present = this.columnsOf(table);
    for (const [column, definition] of Object.entries(definitions)) {
      if (!present.includes(column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
    did?: string;
  }): AgentRow | undefined {
    if (this.agentByHandle(input.handle) !== undefined) return undefined;
    if (input.did !== undefined && this.agentByDid(input.did) !== undefined) return undefined;
    const ownerId = newId("own");
    const agentId = newId("agt");
    const at = nowIso();
    this.db.run("INSERT INTO owners (id, created_at) VALUES (?, ?)", [ownerId, at]);
    this.db.run(
      `INSERT INTO agents (id, owner_id, handle, display_name, bio, token, did, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId,
        ownerId,
        input.handle,
        input.displayName,
        input.bio ?? null,
        // Vestigial. Nothing authenticates with this any more — a socket answers a signed
        // challenge instead — but the column is NOT NULL UNIQUE from the first schema, and
        // SQLite cannot drop an indexed column without rebuilding the table. Filled with
        // something unique and never read again; the rebuild can wait for a reason of its own.
        crypto.randomUUID().replaceAll("-", ""),
        input.did ?? null,
        at,
      ],
    );
    return this.agentById(agentId);
  }

  agentByDid(did: string): AgentRow | undefined {
    return this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE did = ?").get(did) ?? undefined;
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

  createInvite(
    fromAgent: string,
    toAgent: string,
    purpose: string,
    limit: Limit = DEFAULT_LIMIT,
  ): Invite | undefined {
    const from = this.agentById(fromAgent);
    const to = this.agentById(toAgent);
    if (from === undefined || to === undefined) return undefined;
    const id = newId("inv");
    const at = nowIso();
    this.db.run(
      "INSERT INTO invites (id, from_agent, to_agent, purpose, status, created_at, limit_json) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
      [id, fromAgent, toAgent, purpose, at, JSON.stringify(limit)],
    );
    return this.inviteView(id);
  }

  inviteById(id: string): InviteRow | undefined {
    return (
      this.db
        .query<InviteRow, [string]>("SELECT * FROM invites WHERE id = ?")
        .get(id) ?? undefined
    );
  }

  inviteView(id: string): Invite | undefined {
    const row = this.inviteById(id);
    return row === undefined ? undefined : this.toInvite(row);
  }

  setInviteStatus(id: string, status: "accepted" | "declined"): void {
    this.db.run("UPDATE invites SET status = ? WHERE id = ?", [status, id]);
  }

  pendingInvitesFor(agentId: string): Invite[] {
    const rows = this.db
      .query<InviteRow, [string, string]>(
        "SELECT * FROM invites WHERE (to_agent = ? OR from_agent = ?) AND status = 'pending' ORDER BY created_at DESC",
      )
      .all(agentId, agentId);
    return rows.flatMap((row) => {
      const view = this.toInvite(row);
      return view === undefined ? [] : [view];
    });
  }

  private toInvite(row: InviteRow): Invite | undefined {
    const from = this.agentById(row.from_agent);
    const to = this.agentById(row.to_agent);
    if (from === undefined || to === undefined) return undefined;
    return {
      id: row.id,
      fromHandle: from.handle,
      toHandle: to.handle,
      purpose: row.purpose,
      limit: HubStore.parseLimit(row.limit_json ?? ""),
      status: row.status as Invite["status"],
      at: row.created_at,
    };
  }

  /* ---------------- conversations and messages ---------------- */

  /**
   * Open a room on a connection, with both ends of it as the founding members.
   *
   * `openedBy` goes in first. Membership order decides who is offered a turn when several
   * people are owed one and the allowance will not stretch to all of them, so it has to
   * mean something — and a connection stores its pair sorted by id, which would have made
   * that "whoever's id sorts lower". Whose room it is, is the honest answer.
   */
  createConversation(
    connectionId: string,
    purpose: string,
    limit: Limit = DEFAULT_LIMIT,
    openedBy?: string,
  ): Conversation | undefined {
    const pair = this.connectionParticipants(connectionId);
    if (pair === undefined) return undefined;
    const participants =
      openedBy !== undefined && pair.includes(openedBy)
        ? [openedBy, ...pair.filter((agentId) => agentId !== openedBy)]
        : pair;
    const id = newId("cnv");
    const at = nowIso();
    const turns = limit.kind === "turns" ? limit.turns : DEFAULT_TURN_BUDGET;
    this.db.run(
      "INSERT INTO conversations (id, connection_id, purpose, budget, budget_max, limit_json, created_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, connectionId, purpose, turns, turns, JSON.stringify(limit), at, at],
    );
    for (const agentId of participants) this.addMember(id, agentId);
    return this.conversation(id);
  }

  private static toMessage(row: MessageRow): Message {
    const signature = signatureOf(row);
    return {
      id: row.id,
      conversationId: row.conversation_id,
      authorHandle: row.handle,
      kind: row.kind as MessageKind,
      text: row.text,
      at: row.at,
      ...(signature !== undefined ? { signature } : {}),
    };
  }

  /** Same forgiveness as `parseLimit`: a row from another build reads as a running room. */
  private static parseRoomState(raw: string): RoomState {
    const parsed = roomStateSchema.safeParse(raw);
    return parsed.success ? parsed.data : "live";
  }

  /** Parse a stored rule, falling back rather than throwing on a row written by an older build. */
  private static parseLimit(raw: string): Limit {
    try {
      const parsed = limitSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
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
          state: string;
          last_at: string;
        },
        [string]
      >(
        "SELECT id, connection_id, purpose, budget, budget_max, limit_json, spent_usd, spend_incomplete, state, last_at FROM conversations WHERE id = ?",
      )
      .get(id);
    if (row === null || row === undefined) return undefined;
    const handles = this.db
      .query<{ handle: string }, [string]>(
        `SELECT a.handle FROM conversation_members m
         JOIN agents a ON a.id = m.agent_id
         WHERE m.conversation_id = ?
         ORDER BY m.joined_at, m.rowid`,
      )
      .all(id)
      .map((member) => member.handle);
    return {
      id: row.id,
      connectionId: row.connection_id,
      purpose: row.purpose,
      participants: handles,
      budgetRemaining: row.budget,
      limit: HubStore.parseLimit(row.limit_json),
      spentUSD: row.spent_usd,
      spendIncomplete: row.spend_incomplete === 1,
      state: HubStore.parseRoomState(row.state),
      bowedOut: this.db
        .query<{ handle: string }, [string]>(
          `SELECT a.handle FROM conversation_members m
           JOIN agents a ON a.id = m.agent_id
           WHERE m.conversation_id = ? AND m.bowed_out_at IS NOT NULL
           ORDER BY m.bowed_out_at, a.handle`,
        )
        .all(id)
        .map((member) => member.handle),
      lastAt: row.last_at,
    };
  }

  conversationsFor(agentId: string): Conversation[] {
    const rows = this.db
      .query<{ id: string }, [string]>(
        `SELECT c.id FROM conversations c
         JOIN conversation_members m ON m.conversation_id = c.id
         WHERE m.agent_id = ?
         ORDER BY c.last_at DESC`,
      )
      .all(agentId);
    return rows.flatMap((row) => {
      const conversation = this.conversation(row.id);
      return conversation ? [conversation] : [];
    });
  }

  /**
   * Everyone in a conversation, so the hub knows who to wake and who to skip.
   *
   * Ordered by when they joined, which is the order turns are offered in when several
   * people are owed one at once — the room's own history rather than whatever the database
   * felt like returning.
   *
   * Undefined means no such room. A room with no members left is closed and returns an
   * empty list, which is different and reads differently at every call site.
   */
  conversationParticipantIds(conversationId: string): string[] | undefined {
    const exists = this.db
      .query<{ id: string }, [string]>("SELECT id FROM conversations WHERE id = ?")
      .get(conversationId);
    if (exists === null || exists === undefined) return undefined;
    return this.db
      .query<{ agent_id: string }, [string]>(
        `SELECT agent_id FROM conversation_members
         WHERE conversation_id = ? ORDER BY joined_at, rowid`,
      )
      .all(conversationId)
      .map((member) => member.agent_id);
  }

  /* ---------------- who is in a room ---------------- */

  addMember(conversationId: string, agentId: string): void {
    this.db.run(
      `INSERT OR IGNORE INTO conversation_members (conversation_id, agent_id, joined_at)
       VALUES (?, ?, ?)`,
      [conversationId, agentId, nowIso()],
    );
  }

  removeMember(conversationId: string, agentId: string): void {
    this.db.run("DELETE FROM conversation_members WHERE conversation_id = ? AND agent_id = ?", [
      conversationId,
      agentId,
    ]);
    // A turn owed to somebody who has left is not owed to anybody.
    this.clearInFlight(conversationId, agentId);
  }

  /**
   * Which members' agents have said goodbye.
   *
   * Ordered so two hubs reading the same room agree, which matters only because the list
   * reaches the app and a jumping order looks like something changed when nothing did.
   */
  bowedOut(conversationId: string): string[] {
    return this.db
      .query<{ agent_id: string }, [string]>(
        `SELECT agent_id FROM conversation_members
         WHERE conversation_id = ? AND bowed_out_at IS NOT NULL
         ORDER BY bowed_out_at, agent_id`,
      )
      .all(conversationId)
      .map((row) => row.agent_id);
  }

  setBowedOut(conversationId: string, agentId: string, bowedOut: boolean): void {
    this.db.run(
      `UPDATE conversation_members SET bowed_out_at = ?
       WHERE conversation_id = ? AND agent_id = ?`,
      [bowedOut ? nowIso() : null, conversationId, agentId],
    );
  }

  isMember(conversationId: string, agentId: string): boolean {
    const row = this.db
      .query<{ agent_id: string }, [string, string]>(
        "SELECT agent_id FROM conversation_members WHERE conversation_id = ? AND agent_id = ?",
      )
      .get(conversationId, agentId);
    return row !== null && row !== undefined;
  }

  appendMessage(input: {
    conversationId: string;
    authorAgentId: string;
    kind: MessageKind;
    text: string;
    signature?: Signature;
  }): Message | undefined {
    const author = this.agentById(input.authorAgentId);
    if (author === undefined) return undefined;
    const id = newId("msg");
    const at = nowIso();
    const signature = input.signature;
    this.db.run(
      `INSERT INTO messages
         (id, conversation_id, author_agent, kind, text, at,
          sig_did, sig_at, sig_nonce, sig_prev, sig_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.conversationId,
        input.authorAgentId,
        input.kind,
        input.text,
        at,
        signature?.did ?? null,
        signature?.authoredAt ?? null,
        signature?.nonce ?? null,
        signature?.prev ?? null,
        signature?.value ?? null,
      ],
    );
    this.db.run("UPDATE conversations SET last_at = ? WHERE id = ?", [at, input.conversationId]);
    return {
      id,
      conversationId: input.conversationId,
      authorHandle: author.handle,
      kind: input.kind,
      text: input.text,
      at,
      ...(signature !== undefined ? { signature } : {}),
    };
  }

  /**
   * The most recent messages in rooms this agent is in, oldest first per conversation.
   *
   * Windowed, because this runs on every hello: an agent in a dozen long-running rooms was
   * pulling six thousand rows on each reconnect, which is precisely when a flapping network
   * makes it run again. The browser asks for anything older by the page.
   */
  messagesForAgent(agentId: string, perConversation = WELCOME_TRANSCRIPT_WINDOW): Message[] {
    return this.conversationsFor(agentId).flatMap((conversation) =>
      this.transcript(conversation.id, perConversation),
    );
  }

  /**
   * The most recent `limit` messages, oldest first — the window an agent answers from.
   *
   * The author's handle comes from a join rather than a lookup per row. It was a query per
   * message, on the hub's hottest read.
   */
  transcript(conversationId: string, limit: number): Message[] {
    const rows = this.db
      .query<MessageRow, [string, number]>(
        `${MESSAGE_SELECT}
         WHERE m.conversation_id = ?
         ORDER BY m.at DESC, m.rowid DESC
         LIMIT ?`,
      )
      .all(conversationId, limit);
    return rows.reverse().map(HubStore.toMessage);
  }

  /**
   * The page of messages immediately older than `beforeId`, oldest first.
   *
   * Keyset paging on `(at, rowid)` rather than an offset: an offset would drift under any
   * message arriving mid-scroll, and this is the same ordering `transcript` reads by, so it
   * uses the same index. `reachedStart` is answered by asking for one row more than the
   * caller wants and seeing whether it exists — cheaper than a second count query, and it
   * cannot disagree with the page it was measured against.
   */
  historyBefore(
    conversationId: string,
    beforeId: string,
    limit: number,
  ): { messages: Message[]; reachedStart: boolean } {
    const anchor = this.db
      .query<{ at: string; rowid: number }, [string, string]>(
        "SELECT at, rowid FROM messages WHERE conversation_id = ? AND id = ?",
      )
      .get(conversationId, beforeId);
    if (anchor === null || anchor === undefined) return { messages: [], reachedStart: true };

    const rows = this.db
      .query<MessageRow, [string, string, string, number, number]>(
        `${MESSAGE_SELECT}
         WHERE m.conversation_id = ?
           AND (m.at < ? OR (m.at = ? AND m.rowid < ?))
         ORDER BY m.at DESC, m.rowid DESC
         LIMIT ?`,
      )
      .all(conversationId, anchor.at, anchor.at, anchor.rowid, limit + 1);

    const reachedStart = rows.length <= limit;
    return {
      messages: rows.slice(0, limit).reverse().map(HubStore.toMessage),
      reachedStart,
    };
  }

  /**
   * Whether this room is holding something this agent has not answered.
   *
   * The question a bridge coming back online needs answered: a message that arrived while
   * it was away never became a turn, because the hub does not dispatch to a socket that is
   * not there. Nothing later re-asked, so the room simply stayed quiet.
   *
   * Two rules are expressed here rather than in the policy, because both are about which
   * message came last and that is what a database is for:
   *
   * - Only another agent's *spoken* message is something to answer. A pass is deliberate
   *   silence and does not wake anybody, and a system note is the room talking about itself.
   * - This agent having spoken or passed counts as its answer. That is what stops one
   *   message being answered twice. See `OWN_UTTERANCE` for what does not count.
   *
   * `rowid` rather than `at`, because this is only ever a question of order within one
   * table and rowid is the one column guaranteed to answer it.
   */
  owesTurn(conversationId: string, agentId: string): boolean {
    const row = this.db
      .query<{ mine: number | null; theirs: number | null }, [string, string, string, string]>(
        `SELECT
           (SELECT MAX(m.rowid) FROM messages m
            WHERE m.conversation_id = ? AND m.author_agent = ? AND ${OWN_UTTERANCE}) AS mine,
           (SELECT MAX(m.rowid) FROM messages m
            WHERE m.conversation_id = ? AND m.author_agent <> ? AND m.kind = 'agent') AS theirs`,
      )
      .get(conversationId, agentId, conversationId, agentId);
    if (row === null || row === undefined || row.theirs === null) return false;
    return row.mine === null || row.theirs > row.mine;
  }

  /**
   * The slice of a room one agent should be sent for its turn, oldest first.
   *
   * Everything it has not had its say on, plus `overlap` messages it has — and `earlier`,
   * the count of what came before that. It is not the whole room on purpose: the agent
   * resumes a jazz thread that already holds what it was told before, so re-sending a fixed
   * window would spend the room's allowance repeating itself, and spend more of it the
   * longer the conversation ran.
   *
   * Capped at `TURN_SLICE_MAX` from the newest end, so an agent that has been away for a
   * week is given the recent argument rather than a payload nothing will accept.
   */
  transcriptFor(
    conversationId: string,
    agentId: string,
    overlap: number,
    cap: number = TURN_SLICE_MAX,
  ): { messages: Message[]; earlier: number } {
    const counts = this.db
      .query<{ total: number; unanswered: number }, [string, string, string]>(
        `SELECT
           (SELECT COUNT(*) FROM messages WHERE conversation_id = ?) AS total,
           (SELECT COUNT(*) FROM messages m
            WHERE m.conversation_id = ?
              AND m.rowid > COALESCE(
                (SELECT MAX(mine.rowid) FROM messages mine
                 WHERE mine.conversation_id = m.conversation_id
                   AND mine.author_agent = ?
                   AND mine.kind IN ('agent', 'pass')), 0)) AS unanswered`,
      )
      .get(conversationId, conversationId, agentId);
    const total = counts?.total ?? 0;
    const unanswered = counts?.unanswered ?? 0;

    const want = Math.max(1, Math.min(cap, unanswered + overlap));
    const messages = this.transcript(conversationId, want);
    return { messages, earlier: Math.max(0, total - messages.length) };
  }

  /* ---------------- turns the hub is waiting on ---------------- */

  /**
   * Record a turn as in flight, or update what is queued behind it.
   *
   * `dispatched_at` is written once and never touched again, so the deadline a recovered
   * turn is given is measured from when the money was actually spent rather than from when
   * the hub happened to come back.
   */
  saveInFlight(conversationId: string, agentId: string, entry: InFlight): void {
    this.db.run(
      `INSERT INTO turns_in_flight
         (conversation_id, agent_id, dispatched_at, pending, steered, queued_steer, dispatch_steer)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, agent_id) DO UPDATE SET
         pending = excluded.pending,
         steered = excluded.steered,
         queued_steer = excluded.queued_steer,
         dispatch_steer = excluded.dispatch_steer`,
      [
        conversationId,
        agentId,
        nowIso(),
        entry.pending ? 1 : 0,
        entry.steered ? 1 : 0,
        entry.queuedSteer ?? null,
        entry.dispatchSteer ?? null,
      ],
    );
  }

  clearInFlight(conversationId: string, agentId: string): void {
    this.db.run("DELETE FROM turns_in_flight WHERE conversation_id = ? AND agent_id = ?", [
      conversationId,
      agentId,
    ]);
  }

  /** Every turn the hub was waiting on, for the orchestrator to pick back up at boot. */
  allInFlight(): { conversationId: string; agentId: string; dispatchedAt: string; entry: InFlight }[] {
    return this.db
      .query<
        {
          conversation_id: string;
          agent_id: string;
          dispatched_at: string;
          pending: number;
          steered: number;
          queued_steer: string | null;
          dispatch_steer: string | null;
        },
        []
      >(
        `SELECT conversation_id, agent_id, dispatched_at, pending, steered, queued_steer, dispatch_steer
         FROM turns_in_flight`,
      )
      .all()
      .map((row) => ({
        conversationId: row.conversation_id,
        agentId: row.agent_id,
        dispatchedAt: row.dispatched_at,
        entry: {
          pending: row.pending === 1,
          steered: row.steered === 1,
          ...(row.queued_steer !== null ? { queuedSteer: row.queued_steer } : {}),
          ...(row.dispatch_steer !== null ? { dispatchSteer: row.dispatch_steer } : {}),
        },
      }));
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
    // Only the rule and its ceiling. The remaining turns and the room's state are the turn
    // policy's to decide — it is the caller here, and having this method reach for them too
    // meant two writers racing over the same two columns, with the winner decided by
    // statement order rather than by anything anyone had reasoned about.
    const turns = limit.kind === "turns" ? limit.turns : 0;
    this.db.run("UPDATE conversations SET limit_json = ?, budget_max = ? WHERE id = ?", [
      JSON.stringify(limit),
      turns,
      conversationId,
    ]);
  }

  /**
   * Record whether a room is running, halted, or closed.
   *
   * Its own column rather than a zeroed budget: stopping must not quietly rewrite the
   * allowance somebody chose, and under a cost or unlimited rule there is no turn counter to
   * zero in the first place.
   */
  setState(conversationId: string, state: RoomState): void {
    this.db.run("UPDATE conversations SET state = ? WHERE id = ?", [state, conversationId]);
  }

  roomState(conversationId: string): RoomState {
    const row = this.db
      .query<{ state: string }, [string]>("SELECT state FROM conversations WHERE id = ?")
      .get(conversationId);
    return row === null || row === undefined ? "live" : HubStore.parseRoomState(row.state);
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

  /** Write the conversation's spend as the policy currently sees it. */
  setSpend(conversationId: string, usd: number, incomplete: boolean): void {
    this.db.run("UPDATE conversations SET spent_usd = ?, spend_incomplete = ? WHERE id = ?", [
      usd,
      incomplete ? 1 : 0,
      conversationId,
    ]);
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
      ...(row.did !== null ? { did: row.did } : {}),
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
