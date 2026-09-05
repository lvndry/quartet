/**
 * @fileoverview Everything the hub remembers.
 *
 * SQLite, for the reason in `docs/design/limits.md`: the socket registry is already per-process
 * state, so one process with one file is the honest expression of that. Every read and write
 * goes through this module, so the swap is real the day it stops being true.
 *
 * Two modelling choices are cheap now and painful later, so they are made here rather than
 * left to policy: a person is a row rather than a column, and a connection is separate from
 * a conversation. Both are explained in `docs/design/rooms.md`.
 */

import { Database } from "bun:sqlite";
import { tag as tagFor } from "@quartet/identity";
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
  type Member,
  type Message,
  type MessageKind,
  type SealingClaim,
  type Signature,
} from "@quartet/protocol";

export interface AgentRow {
  id: string;
  owner_id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  token: string;
  /** What this agent *is*. Required, because an agent nothing can name is not addressable. */
  did: string;
  /**
   * The sealing key this agent published, and its own signature over it.
   *
   * All three or none: a claim is only worth relaying whole, and the hub verified it once on
   * the handshake precisely so it never has to reason about a half of one.
   */
  sealing_did: string | null;
  sealing_at: string | null;
  sealing_proof: string | null;
  created_at: string;
}

/** One message with its author's key already resolved. See `MESSAGE_SELECT`. */
interface MessageRow {
  id: string;
  conversation_id: string;
  did: string;
  kind: string;
  text: string;
  at: string;
  sig_did: string | null;
  sig_at: string | null;
  sig_nonce: string | null;
  sig_prev: string | null;
  sig_dispatch: string | null;
  sig_value: string | null;
}

/**
 * The projection every transcript read shares.
 *
 * One string, so two readers cannot drift into disagreeing about what a message is. The join
 * also decides what happens to a message whose author is gone: it disappears.
 */
const MESSAGE_SELECT = `SELECT m.id, m.conversation_id, a.did, m.kind, m.text, m.at,
            m.sig_did, m.sig_at, m.sig_nonce, m.sig_prev, m.sig_dispatch, m.sig_value
     FROM messages m
     JOIN agents a ON a.id = m.author_agent`;

/**
 * What counts as an agent having had its say: its own words, or its own deliberate silence.
 *
 * Deliberately not "any message attributed to this agent". A system note is the room talking
 * about itself and is attributed to whoever provoked it — so counting a failed turn's note as
 * an answer suppressed the retry and nobody answered the message at all.
 */
const OWN_UTTERANCE = "m.kind IN ('agent', 'pass')";

/**
 * How long a settled dispatch is remembered.
 *
 * Long enough that a bridge which slept through the weekend is not mistaken for a replay,
 * short enough that the table stays small. Forgetting one early costs nothing: the message
 * nonce constraint refuses the duplicate anyway.
 */
const DISPATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
 * All-or-nothing: a partly filled row is a hub edited underneath itself, and a half-built
 * signature would surface as "your correspondent is lying" rather than "this database is
 * damaged".
 */
function signatureOf(row: MessageRow): Signature | undefined {
  const { sig_did, sig_at, sig_nonce, sig_prev, sig_dispatch, sig_value } = row;
  if (sig_did === null || sig_at === null || sig_nonce === null) return undefined;
  if (sig_prev === null || sig_dispatch === null || sig_value === null) return undefined;
  return {
    did: sig_did,
    authoredAt: sig_at,
    nonce: sig_nonce,
    prev: sig_prev,
    dispatch: sig_dispatch,
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
        -- Not unique: a handle is a name, and two people who have never met are entitled to
        -- the same one. What is unique is did below, because that is the identity. See
        -- docs/design/identity.md.
        handle        TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        bio           TEXT,
        token         TEXT NOT NULL UNIQUE,
        -- The key this agent signs with, and the only unique thing about it. Required:
        -- once a handle is a label, an agent without a key has nothing anybody could use to
        -- name it, invite it, or check a word it said.
        did           TEXT NOT NULL UNIQUE,
        -- The X25519 key other agents seal this one's copy to, with the Ed25519 signature
        -- over it by did above. Stored, relayed, and never minted here: the hub does not
        -- hold the key that signs one, which is what stops it substituting its own and
        -- reading the room. Nullable together, for a row that exists before any bridge has
        -- connected.
        sealing_did   TEXT,
        sealing_at    TEXT,
        sealing_proof TEXT,
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
        -- Who opened the room. Stored rather than read off the member order, because whose
        -- turn it is to accept is a question about consent and member order is not.
        proposed_by    TEXT,
        created_at     TEXT NOT NULL,
        last_at        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id),
        author_agent     TEXT NOT NULL REFERENCES agents(id),
        kind             TEXT NOT NULL,
        text             TEXT NOT NULL,
        at               TEXT NOT NULL,
        sig_did          TEXT,
        sig_at           TEXT,
        sig_nonce        TEXT,
        sig_prev         TEXT,
        sig_dispatch     TEXT,
        sig_value        TEXT
      );

      -- Who is in a room. Not read off the connection, which is a pair by definition: that
      -- is where a room started, not who is in it.
      CREATE TABLE IF NOT EXISTS conversation_members (
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        agent_id        TEXT NOT NULL REFERENCES agents(id),
        joined_at       TEXT NOT NULL,
        -- When this member's agent said goodbye. Durable, because a hub restart must not
        -- resurrect an agent whose owner is no longer paying for it to talk.
        bowed_out_at    TEXT,
        -- When this member asked for the room to be erased for everyone. Erasure happens
        -- only once every current member has, so this is a vote that has to survive a
        -- restart: losing it would silently reset an agreement people had already reached.
        erase_asked_at  TEXT,
        PRIMARY KEY (conversation_id, agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_members_agent ON conversation_members(agent_id);

      -- Turns the hub has charged for and is waiting on. Durable because the charge is:
      -- Orchestrator.recover reads these back at boot.
      CREATE TABLE IF NOT EXISTS turns_in_flight (
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        agent_id        TEXT NOT NULL REFERENCES agents(id),
        dispatch_id     TEXT NOT NULL,
        dispatched_at   TEXT NOT NULL,
        pending         INTEGER NOT NULL DEFAULT 0,
        steered         INTEGER NOT NULL DEFAULT 0,
        queued_steer    TEXT,
        dispatch_steer  TEXT,
        PRIMARY KEY (conversation_id, agent_id)
      );

      -- Every turn the hub has handed out, and whether it has been answered.
      --
      -- Separate from turns_in_flight, which is one row per agent per room and is what the
      -- turn policy reads. This is the ledger, and it answers two different questions: was
      -- this agent given the floor, and has it already used it. Deliberately outlives the
      -- deadline — see docs/design/turns.md.
      CREATE TABLE IF NOT EXISTS dispatches (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        agent_id        TEXT NOT NULL,
        dispatched_at   TEXT NOT NULL,
        settled_at      TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_dispatches_room ON dispatches(conversation_id, agent_id);
      CREATE INDEX IF NOT EXISTS idx_dispatches_settled ON dispatches(settled_at);

      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, at);
      -- One nonce per author per room, ever. The constraint is the enforcement rather than a
      -- check some future caller can forget to make.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sig_nonce
        ON messages(conversation_id, sig_did, sig_nonce)
        WHERE sig_nonce IS NOT NULL;
      -- Serves owesTurn, which asks who spoke last rather than what was said. Without it
      -- that answer costs a scan of every message in the room, on every event.
      CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(conversation_id, author_agent);
      CREATE INDEX IF NOT EXISTS idx_invites_to ON invites(to_agent, status);
    `);

    // Past their retention they are history nobody reads, and the table would grow forever.
    this.db.run("DELETE FROM dispatches WHERE settled_at IS NOT NULL AND settled_at < ?", [
      new Date(Date.now() - DISPATCH_RETENTION_MS).toISOString(),
    ]);
  }

  /**
   * Run several writes as one, so a crash cannot land half of them.
   *
   * The turn transition is why this exists — see `docs/design/turns.md`.
   */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
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
    did: string;
  }): AgentRow | undefined {
    // A key claims once. A name is claimed as often as people happen to share it — which
    // among friends is often, and telling somebody to be @mira2 on this hub because a friend
    // got here first is a worse answer than carrying the fingerprint that already tells them
    // apart everywhere else.
    if (this.agentByDid(input.did) !== undefined) return undefined;
    if (this.agentByTag(tagFor(input.handle, input.did)) !== undefined) return undefined;
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
        input.did,
        at,
      ],
    );
    return this.agentById(agentId);
  }

  agentByDid(did: string): AgentRow | undefined {
    return this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE did = ?").get(did) ?? undefined;
  }

  /**
   * The agent somebody meant by `@mira#4f2a-…`.
   *
   * The name people write down, and the only one that stays unambiguous once a handle can be
   * worn by more than one key. A bare handle is deliberately not accepted: on a hub with two
   * @mira, picking one of them would be picking somebody's correspondent for them.
   */
  agentByTag(wanted: string | undefined): AgentRow | undefined {
    if (wanted === undefined) return undefined;
    for (const row of this.allAgents()) {
      if (tagFor(row.handle, row.did) === wanted) return row;
    }
    return undefined;
  }

  /** Whose agent proposed this room, as an id rather than a name. */
  proposerId(conversationId: string): string | undefined {
    return (
      this.db
        .query<{ proposed_by: string | null }, [string]>(
          "SELECT proposed_by FROM conversations WHERE id = ?",
        )
        .get(conversationId)?.proposed_by ?? undefined
    );
  }

  agentById(id: string): AgentRow | undefined {
    return this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id) ?? undefined;
  }

  /**
   * Remember the sealing key an agent just proved on the handshake.
   *
   * Overwrites rather than appends: rotation is publishing a new signed key, and the hub
   * holds only what to seal to *next*. Everything already sealed to the old key stays sealed
   * to it, and the only copy of that key lives on the bridge that made it — which is why the
   * hub losing this row costs a reconnect and nothing more.
   */
  recordSealingKey(agentId: string, claim: SealingClaim): void {
    this.db.run("UPDATE agents SET sealing_did = ?, sealing_at = ?, sealing_proof = ? WHERE id = ?", [
      claim.sealingDid,
      claim.at,
      claim.proof,
      agentId,
    ]);
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
      fromDid: from.did,
      toDid: to.did,
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
  /**
   * Open a room, proposed rather than running.
   *
   * Nothing dispatches until the other side takes it up — an agent's turn spends its
   * owner's money and speaks in their name, so being willing to talk to somebody is not
   * standing consent to every conversation they open afterwards.
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
      "INSERT INTO conversations (id, connection_id, purpose, budget, budget_max, limit_json, created_at, last_at, state, proposed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)",
      [id, connectionId, purpose, turns, turns, JSON.stringify(limit), at, at, openedBy ?? null],
    );
    for (const agentId of participants) this.addMember(id, agentId);
    return this.conversation(id);
  }

  private static toMessage(row: MessageRow): Message {
    const signature = signatureOf(row);
    return {
      id: row.id,
      conversationId: row.conversation_id,
      authorDid: row.did,
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

  /** The key for an agent id, when there is one. */
  private didOf(agentId: string | null): string | undefined {
    if (agentId === null) return undefined;
    return (
      this.db
        .query<{ did: string }, [string]>("SELECT did FROM agents WHERE id = ?")
        .get(agentId)?.did ?? undefined
    );
  }

  /**
   * Take up a proposed room, or turn it down, as the side that did not open it.
   *
   * The proposer cannot answer their own proposal, which would make the approval decorative.
   * A room past `proposed` is already answered, so a repeated tap changes nothing.
   */
  respondToConversation(
    conversationId: string,
    agentId: string,
    accept: boolean,
  ): Conversation | undefined {
    const conversation = this.conversation(conversationId);
    if (conversation === undefined || conversation.state !== "proposed") return undefined;

    // Compared by id, not by name. Once two agents can wear one handle, a name in a
    // membership test is a hole: the @mira who is not in this room would pass it.
    const responder = this.agentById(agentId);
    if (responder === undefined || responder.id === this.proposerId(conversationId)) return undefined;
    if (!(this.conversationParticipantIds(conversationId) ?? []).includes(responder.id)) {
      return undefined;
    }

    // Declined rooms close rather than vanish: the proposer is owed the answer, and a room
    // that disappeared would read as a bug on their side.
    this.setState(conversationId, accept ? "live" : "closed");
    return this.conversation(conversationId);
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
          proposed_by: string | null;
          last_at: string;
        },
        [string]
      >(
        "SELECT id, connection_id, purpose, budget, budget_max, limit_json, spent_usd, spend_incomplete, state, proposed_by, last_at FROM conversations WHERE id = ?",
      )
      .get(id);
    if (row === null || row === undefined) return undefined;
    const members = this.db
      .query<
        {
          handle: string;
          did: string;
          sealing_did: string | null;
          sealing_at: string | null;
          sealing_proof: string | null;
        },
        [string]
      >(
        `SELECT a.handle, a.did, a.sealing_did, a.sealing_at, a.sealing_proof
         FROM conversation_members m
         JOIN agents a ON a.id = m.agent_id
         WHERE m.conversation_id = ?
         ORDER BY m.joined_at, m.rowid`,
      )
      .all(id)
      .map(HubStore.toMember);
    return {
      id: row.id,
      connectionId: row.connection_id,
      purpose: row.purpose,
      participants: members,
      budgetRemaining: row.budget,
      limit: HubStore.parseLimit(row.limit_json),
      spentUSD: row.spent_usd,
      spendIncomplete: row.spend_incomplete === 1,
      state: HubStore.parseRoomState(row.state),
      proposedBy: this.didOf(row.proposed_by) ?? "",
      bowedOut: this.markedMembers(id, "bowed_out_at"),
      eraseAsked: this.markedMembers(id, "erase_asked_at"),
      lastAt: row.last_at,
    };
  }

  /**
   * Members carrying a timestamp in one column, by handle.
   *
   * Ordered by that timestamp so the list the app shows does not jump around.
   *
   * The column name is interpolated, which is safe only because both callers pass a literal —
   * keeping it to one function is the point.
   */
  private markedMembers(conversationId: string, column: "bowed_out_at" | "erase_asked_at"): string[] {
    return this.db
      .query<{ did: string }, [string]>(
        `SELECT a.did FROM conversation_members m
         JOIN agents a ON a.id = m.agent_id
         WHERE m.conversation_id = ? AND m.${column} IS NOT NULL
         ORDER BY m.${column}, a.handle`,
      )
      .all(conversationId)
      .map((member) => member.did);
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

  /**
   * Record that this member wants the room erased for everyone.
   *
   * Keeps the first timestamp — asking twice is not a stronger ask — and returns whether this
   * was new, so a repeated tap does not say the same thing in the room again.
   */
  askErase(conversationId: string, agentId: string): boolean {
    const written = this.db.run(
      `UPDATE conversation_members SET erase_asked_at = ?
       WHERE conversation_id = ? AND agent_id = ? AND erase_asked_at IS NULL`,
      [nowIso(), conversationId, agentId],
    );
    return written.changes === 1;
  }

  /**
   * Whether every current member has asked for erasure.
   *
   * "Current" is what keeps this reachable: somebody who leaves is no longer waited on, so an
   * absentee cannot freeze the request forever.
   */
  everyoneAskedErase(conversationId: string): boolean {
    const row = this.db
      .query<{ members: number; asked: number }, [string]>(
        `SELECT COUNT(*) AS members,
                COUNT(erase_asked_at) AS asked
         FROM conversation_members WHERE conversation_id = ?`,
      )
      .get(conversationId);
    if (row === null || row === undefined) return false;
    return row.members === row.asked;
  }

  /**
   * Erase a room and everything said in it from the hub's own copy.
   *
   * Child-first, because foreign keys are enforced. Each participant's own bridge journal is
   * a separate durable record and is untouched — this is only the shared copy.
   */
  deleteConversation(conversationId: string): void {
    this.db.run("DELETE FROM dispatches WHERE conversation_id = ?", [conversationId]);
    this.db.run("DELETE FROM turns_in_flight WHERE conversation_id = ?", [conversationId]);
    this.db.run("DELETE FROM messages WHERE conversation_id = ?", [conversationId]);
    this.db.run("DELETE FROM conversation_members WHERE conversation_id = ?", [conversationId]);
    this.db.run("DELETE FROM conversations WHERE id = ?", [conversationId]);
  }

  isMember(conversationId: string, agentId: string): boolean {
    const row = this.db
      .query<{ agent_id: string }, [string, string]>(
        "SELECT agent_id FROM conversation_members WHERE conversation_id = ? AND agent_id = ?",
      )
      .get(conversationId, agentId);
    return row !== null && row !== undefined;
  }

  /**
   * Whether this author has already used this nonce in this room.
   *
   * The unique index enforces it; this exists so a replay is refused with a sentence rather
   * than a constraint violation.
   */
  nonceUsed(conversationId: string, did: string, nonce: string): boolean {
    const row = this.db
      .query<{ id: string }, [string, string, string]>(
        `SELECT id FROM messages
         WHERE conversation_id = ? AND sig_did = ? AND sig_nonce = ?`,
      )
      .get(conversationId, did, nonce);
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
          sig_did, sig_at, sig_nonce, sig_prev, sig_dispatch, sig_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        signature?.dispatch ?? null,
        signature?.value ?? null,
      ],
    );
    this.db.run("UPDATE conversations SET last_at = ? WHERE id = ?", [at, input.conversationId]);
    return {
      id,
      conversationId: input.conversationId,
      authorDid: author.did,
      kind: input.kind,
      text: input.text,
      at,
      ...(signature !== undefined ? { signature } : {}),
    };
  }

  /**
   * The most recent messages in rooms this agent is in, oldest first per conversation.
   *
   * Windowed because this runs on every hello, which is exactly when a flapping network makes
   * it run repeatedly. The browser asks for anything older by the page.
   */
  messagesForAgent(agentId: string, perConversation = WELCOME_TRANSCRIPT_WINDOW): Message[] {
    return this.conversationsFor(agentId).flatMap((conversation) =>
      this.transcript(conversation.id, perConversation),
    );
  }

  /**
   * The most recent `limit` messages, oldest first.
   *
   * The handle comes from a join, not a lookup per row: that was a query per message on the
   * hub's hottest read.
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
   * `dispatched_at` is written once, so a recovered turn's deadline is measured from when the
   * money was spent rather than from when the hub came back.
   */
  saveInFlight(conversationId: string, agentId: string, entry: InFlight): void {
    this.db.run(
      `INSERT INTO turns_in_flight
         (conversation_id, agent_id, dispatch_id, dispatched_at, pending, steered, queued_steer, dispatch_steer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, agent_id) DO UPDATE SET
         pending = excluded.pending,
         steered = excluded.steered,
         queued_steer = excluded.queued_steer,
         dispatch_steer = excluded.dispatch_steer`,
      [
        conversationId,
        agentId,
        entry.dispatch,
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

  /* ---------------- the dispatch ledger ---------------- */

  /** In the same transaction as the charge, so no bridge holds a turn the hub would refuse. */
  recordDispatch(conversationId: string, agentId: string, dispatchId: string): void {
    this.db.run(
      `INSERT OR IGNORE INTO dispatches (id, conversation_id, agent_id, dispatched_at)
       VALUES (?, ?, ?, ?)`,
      [dispatchId, conversationId, agentId, nowIso()],
    );
  }

  /**
   * Whether this dispatch is one this agent may still answer.
   *
   * Three answers rather than a boolean, because they are different accusations: `unknown` is
   * speaking out of turn, `settled` is a replay. `open` stays open past the deadline — the
   * turn was charged for, so a late answer is still that agent's.
   */
  dispatchState(
    conversationId: string,
    agentId: string,
    dispatchId: string,
  ): "open" | "settled" | "unknown" {
    const row = this.db
      .query<{ settled_at: string | null }, [string, string, string]>(
        `SELECT settled_at FROM dispatches
         WHERE id = ? AND conversation_id = ? AND agent_id = ?`,
      )
      .get(dispatchId, conversationId, agentId);
    if (row === null || row === undefined) return "unknown";
    return row.settled_at === null ? "open" : "settled";
  }

  /**
   * Spend a dispatch, if it is this agent's to spend and nobody has spent it.
   *
   * Scoped to the room and the agent rather than the id alone: the id travels in the
   * signature, so "whoever quotes it may settle it" would let one member answer another's
   * turn.
   */
  settleDispatch(conversationId: string, agentId: string, dispatchId: string): boolean {
    const written = this.db.run(
      `UPDATE dispatches SET settled_at = ?
       WHERE id = ? AND conversation_id = ? AND agent_id = ? AND settled_at IS NULL`,
      [nowIso(), dispatchId, conversationId, agentId],
    );
    return written.changes === 1;
  }

  /** Every turn the hub was waiting on, for the orchestrator to pick back up at boot. */
  allInFlight(): { conversationId: string; agentId: string; dispatchedAt: string; entry: InFlight }[] {
    return this.db
      .query<
        {
          conversation_id: string;
          agent_id: string;
          dispatch_id: string;
          dispatched_at: string;
          pending: number;
          steered: number;
          queued_steer: string | null;
          dispatch_steer: string | null;
        },
        []
      >(
        `SELECT conversation_id, agent_id, dispatch_id, dispatched_at, pending, steered, queued_steer, dispatch_steer
         FROM turns_in_flight`,
      )
      .all()
      .map((row) => ({
        conversationId: row.conversation_id,
        agentId: row.agent_id,
        dispatchedAt: row.dispatched_at,
        entry: {
          dispatch: row.dispatch_id,
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

  /**
   * A room member as the rest of the room needs them: a name and two keys.
   *
   * Static because it takes the projection the membership join produces rather than a whole
   * `AgentRow` — every field here has to travel for a bridge to check the sealing proof, and
   * nothing else does.
   *
   * The claim is passed through whole or dropped whole. A half-stored one would reach a
   * bridge as a key with no proof, and a key with no proof is exactly what a hub minting its
   * own would look like.
   */
  static toMember(row: {
    handle: string;
    did: string;
    sealing_did: string | null;
    sealing_at: string | null;
    sealing_proof: string | null;
  }): Member {
    const complete =
      row.sealing_did !== null && row.sealing_at !== null && row.sealing_proof !== null;
    return {
      handle: row.handle,
      did: row.did,
      ...(complete
        ? {
            sealing: {
              sealingDid: row.sealing_did as string,
              at: row.sealing_at as string,
              proof: row.sealing_proof as string,
            },
          }
        : {}),
    };
  }

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
