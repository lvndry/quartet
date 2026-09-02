import type React from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, Message } from "@quartet/protocol";
import {
  DEFAULT_TURN_BUDGET,
  MAX_ROOM_MEMBERS,
  MAX_SPEND_USD,
  MAX_TURN_BUDGET,
} from "@quartet/protocol";
import {
  call,
  useBridge,
  useSocketLive,
  type Activity,
  type Aside,
  type KeyConflict,
  type Limit,
  type PeerPresence,
  type Verdict,
} from "./store";

// Markdown rendering pulls in KaTeX and the remark/rehype pipeline, which together dwarf the
// rest of the app — loaded only once a conversation is actually open, not on first paint.
const MessageBody = lazy(() =>
  import("./Message").then((module) => ({ default: module.MessageBody })),
);

/**
 * Everyone in a room but you.
 *
 * A list, because a room is no longer two people. Nearly every place that used to reach for
 * `participants.find(h => h !== me)` wanted this and got away with the singular only while
 * rooms were pairs.
 */
function others(conversation: Conversation, meHandle: string): string[] {
  return conversation.participants.filter((handle) => handle !== meHandle);
}

/** "@otto", "@otto and @nia", "@otto, @nia and @ada" — for prose, not for lists. */
function nameThem(handles: readonly string[]): string {
  const tagged = handles.map((handle) => `@${handle}`);
  if (tagged.length === 0) return "nobody";
  if (tagged.length === 1) return tagged[0] ?? "nobody";
  return `${tagged.slice(0, -1).join(", ")} and ${String(tagged[tagged.length - 1])}`;
}

function monogram(handle: string): string {
  return handle.slice(0, 2).toUpperCase();
}

function clock(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The elapsed counter is deliberate: a local model can take thirty seconds, and hiding that
 *  makes the product feel broken rather than honest. */
function Elapsed({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span className="elapsed">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
}

/** Whether the room has spent its allowance and is waiting on a person. */
function roomIsQuiet(conversation: Conversation): boolean {
  if (conversation.limit.kind === "turns") return conversation.budgetRemaining === 0;
  if (conversation.limit.kind === "cost") {
    return conversation.spendIncomplete
      ? conversation.budgetRemaining === 0
      : conversation.spentUSD >= conversation.limit.usd;
  }
  return false;
}

/**
 * The same warning the agents are given, shown to the people watching.
 *
 * They are the ones who would raise the limit, so knowing the room is nearly out matters
 * before it goes quiet rather than after.
 */
function nearingLimit(conversation: Conversation): string | undefined {
  const { limit, budgetRemaining, spentUSD, spendIncomplete } = conversation;
  if (conversation.state !== "live") return undefined;
  if (limit.kind === "turns") {
    if (budgetRemaining === 0) return undefined;
    return budgetRemaining <= 1 ? "last turn" : undefined;
  }
  if (limit.kind === "cost" && !spendIncomplete) {
    const left = limit.usd - spentUSD;
    return left > 0 && left / limit.usd <= 0.2 ? "nearly spent" : undefined;
  }
  return undefined;
}

/** The header keeps a purpose to a glance; a brief can now run to several paragraphs. */
const PURPOSE_HEADER_CHARS = 30;

function shortPurpose(purpose: string): string {
  const flat = purpose.replace(/\s+/g, " ").trim();
  return flat.length <= PURPOSE_HEADER_CHARS
    ? flat
    : `${flat.slice(0, PURPOSE_HEADER_CHARS).trimEnd()}…`;
}

function money(usd: number): string {
  return usd < 0.01 && usd > 0 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/**
 * What this conversation is allowed to spend, and how much of it is gone.
 *
 * Turn dots stop meaning anything under a cost or unlimited rule, so each rule gets the
 * readout that actually tracks it — a row of dots, a running total, or nothing but a count.
 */
function Budget({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const { limit, budgetRemaining, spentUSD, spendIncomplete } = conversation;
  const warning = nearingLimit(conversation);

  if (limit.kind === "turns") {
    return (
      <span className="budget">
        <span className="budget-label">
          {budgetRemaining} / {limit.turns}
        </span>
        <span className="budget-dots">
          {Array.from({ length: Math.min(limit.turns, 20) }, (_, index) => (
            <i key={index} className={index >= budgetRemaining ? "spent" : undefined} />
          ))}
        </span>
        {spentUSD > 0 && (
          <span className="budget-label">
            {spendIncomplete ? "≥" : ""}
            {money(spentUSD)}
          </span>
        )}
        {warning !== undefined && <span className="budget-label warn">{warning}</span>}
      </span>
    );
  }

  if (limit.kind === "cost") {
    const fraction = Math.min(1, spentUSD / limit.usd);
    return (
      <span className="budget">
        <span className="budget-label">spend</span>
        <span className="meter">
          <i style={{ width: `${String(Math.round(fraction * 100))}%` }} />
        </span>
        <span className="budget-label">
          {spendIncomplete ? "≥" : ""}
          {money(spentUSD)} / {money(limit.usd)}
        </span>
        {warning !== undefined && <span className="budget-label warn">{warning}</span>}
      </span>
    );
  }

  return (
    <span className="budget">
      <span className="budget-label warn">unlimited</span>
      <span className="budget-label">
        {spendIncomplete ? "≥" : ""}
        {money(spentUSD)} spent
      </span>
    </span>
  );
}

/**
 * Choosing what a conversation may spend.
 *
 * A kind, then a number you type. Presets were a guess at what somebody would want, and the
 * right ceiling depends entirely on whose model is answering — a hundred turns of a local
 * model and five turns of a frontier model with tool calls cost about the same.
 *
 * The typed value commits on blur or Enter rather than per keystroke, because each commit is
 * a round trip both participants see: applying "1", then "12", then "125" while somebody
 * types would flap the other side's ceiling three times.
 */
function describeLimit(limit: Limit): string {
  if (limit.kind === "turns") return `${String(limit.turns)} turns`;
  if (limit.kind === "cost") return `${money(limit.usd)} cap`;
  return "unlimited";
}

/**
 * A limit you are about to send with an invite or a new room — not yet attached to one.
 */
function LimitDraft({
  value,
  onChange,
}: {
  value: Limit;
  onChange: (limit: Limit) => void;
}): React.JSX.Element {
  const committed =
    value.kind === "turns" ? String(value.turns) : value.kind === "cost" ? String(value.usd) : "";
  const [draft, setDraft] = useState(committed);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(committed);
  }, [committed, editing]);

  function apply(raw: string): void {
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) {
      setDraft(committed);
      return;
    }
    if (value.kind === "cost") onChange({ kind: "cost", usd: Math.min(amount, MAX_SPEND_USD) });
    else onChange({ kind: "turns", turns: Math.min(Math.round(amount), MAX_TURN_BUDGET) });
  }

  return (
    <span className="limit">
      <select
        className="limit-select"
        aria-label="Limit this conversation by"
        value={value.kind}
        onChange={(event) => {
          const kind = event.target.value as Limit["kind"];
          onChange(
            kind === "none"
              ? { kind: "none" }
              : kind === "cost"
                ? { kind: "cost", usd: 1 }
                : { kind: "turns", turns: DEFAULT_TURN_BUDGET },
          );
        }}
      >
        <option value="turns">turns</option>
        <option value="cost">spend</option>
        <option value="none">unlimited</option>
      </select>
      {value.kind !== "none" && (
        <span className="limit-value">
          {value.kind === "cost" && <span className="limit-prefix">$</span>}
          <input
            className="limit-input"
            aria-label={value.kind === "cost" ? "Spend limit in dollars" : "Turn limit"}
            inputMode="decimal"
            value={draft}
            onFocus={() => setEditing(true)}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => {
              setEditing(false);
              const typed = event.currentTarget.value;
              if (typed !== committed) apply(typed);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraft(committed);
                event.currentTarget.blur();
              }
            }}
          />
        </span>
      )}
    </span>
  );
}

/** One line per other member, so a room of four does not hide three of them. */
function PeerStatus({
  handles,
  presence,
}: {
  handles: readonly string[];
  presence: readonly PeerPresence[];
}): React.JSX.Element {
  return (
    <span className="peers">
      {handles.map((handle) => (
        <OnePeer
          key={handle}
          handle={handle}
          presence={presence.find((entry) => entry.handle === handle)}
        />
      ))}
    </span>
  );
}

function OnePeer({
  handle,
  presence,
}: {
  handle: string;
  presence: PeerPresence | undefined;
}): React.JSX.Element {
  if (presence === undefined || !presence.online) {
    return <span className="peer away">@{handle} is away</span>;
  }
  if (presence.thinking) {
    return (
      <span className="peer live">
        @{handle}’s agent is {presence.doing ?? "thinking"}
        {presence.since !== undefined && <Elapsed since={presence.since} />}
      </span>
    );
  }
  if (presence.watching) {
    return <span className="peer live">@{handle} is watching</span>;
  }
  return <span className="peer">@{handle} is here</span>;
}

function LimitPicker({
  conversation,
  onAct,
}: {
  conversation: Conversation;
  onAct: (path: string, body: Record<string, unknown>) => Promise<void>;
}): React.JSX.Element {
  const { limit } = conversation;
  const committed =
    limit.kind === "turns" ? String(limit.turns) : limit.kind === "cost" ? String(limit.usd) : "";
  const [draft, setDraft] = useState(committed);
  const [editing, setEditing] = useState(false);

  // While somebody is typing their own value, leave it alone; otherwise follow the
  // conversation, which the other participant may have changed.
  useEffect(() => {
    if (!editing) setDraft(committed);
  }, [committed, editing]);

  function apply(raw: string): void {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      setDraft(committed);
      return;
    }
    const next: Limit =
      limit.kind === "cost"
        ? { kind: "cost", usd: Math.min(value, MAX_SPEND_USD) }
        : { kind: "turns", turns: Math.min(Math.round(value), MAX_TURN_BUDGET) };
    void onAct("limit", { conversationId: conversation.id, limit: next });
  }

  function changeKind(kind: Limit["kind"]): void {
    const next: Limit =
      kind === "none"
        ? { kind: "none" }
        : kind === "cost"
          ? { kind: "cost", usd: 1 }
          : { kind: "turns", turns: DEFAULT_TURN_BUDGET };
    void onAct("limit", { conversationId: conversation.id, limit: next });
  }

  return (
    <span className="limit">
      <select
        className="limit-select"
        aria-label="Limit this conversation by"
        value={limit.kind}
        onChange={(event) => changeKind(event.target.value as Limit["kind"])}
      >
        <option value="turns">turns</option>
        <option value="cost">spend</option>
        <option value="none">unlimited</option>
      </select>

      {limit.kind !== "none" && (
        <span className="limit-value">
          {limit.kind === "cost" && <span className="limit-prefix">$</span>}
          <input
            className="limit-input"
            aria-label={limit.kind === "cost" ? "Spend limit in dollars" : "Turn limit"}
            inputMode="decimal"
            value={draft}
            onFocus={() => setEditing(true)}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => {
              // Read the value off the element rather than the draft state: the two are the
              // same for anyone typing, but taking it from the event means a commit can never
              // race a pending re-render and silently apply the previous value.
              setEditing(false);
              const typed = event.currentTarget.value;
              if (typed !== committed) apply(typed);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraft(committed);
                event.currentTarget.blur();
              }
            }}
          />
        </span>
      )}

      {conversation.state !== "closed" && (
        <button
          className="btn stop"
          type="button"
          onClick={() => void onAct("stop", { conversationId: conversation.id })}
        >
          Stop
        </button>
      )}
    </span>
  );
}
export default function App(): React.JSX.Element {
  const state = useBridge();
  const live = useSocketLive();
  const [selected, setSelected] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [navOpen, setNavOpen] = useState(false);

  const conversation: Conversation | undefined = useMemo(
    () =>
      state.conversations.find((candidate) => candidate.id === selected) ?? state.conversations[0],
    [state.conversations, selected],
  );

  useEffect(() => {
    if (!state.connectedToHub) return;
    void call("watch", conversation === undefined ? {} : { conversationId: conversation.id });
  }, [conversation?.id, state.connectedToHub]);

  async function act(path: string, body: Record<string, unknown>): Promise<void> {
    setError(await call(path, body));
  }

  return (
    <div className="app">
      <header className="topbar">
        <button
          className="nav-toggle"
          type="button"
          aria-expanded={navOpen}
          aria-controls="rooms"
          onClick={() => setNavOpen((open) => !open)}
        >
          Rooms
        </button>
        <div className="wordmark">
          Quar<span>tet</span>
        </div>
        {state.me !== undefined && (
          <span
            className="whoami"
            title="Give this whole line to anyone inviting you. The part after # is what proves the handle is yours."
          >
            @{state.me.handle}
            {state.me.did !== undefined && (
              <span className="fingerprint">#{state.fingerprints[state.me.did] ?? "unkeyed"}</span>
            )}
          </span>
        )}
        <div className="spacer" />
        <span className={live && state.connectedToHub ? "status live" : "status"}>
          <span className="pip" />
          {!live ? "bridge offline" : state.connectedToHub ? "connected" : "reaching the hub"}
        </span>
      </header>

      <div
        className={navOpen ? "nav-scrim open" : "nav-scrim"}
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />

      <div className="columns">
        <Sidebar
          state={state}
          selectedId={conversation?.id}
          open={navOpen}
          onSelect={(id) => {
            setSelected(id);
            setNavOpen(false);
          }}
          onAct={act}
        />
        {conversation === undefined ? (
          <section className="pane chat">
            <div className="placeholder">
              <p>
                No conversations yet. Find someone you know and invite them — the line you
                write is a topic for your agent, not a message in the room.
              </p>
            </div>
          </section>
        ) : (
          <Chat
            conversation={conversation}
            messages={state.messages[conversation.id] ?? []}
            atStart={state.atStart[conversation.id] ?? true}
            asides={state.asides[conversation.id] ?? []}
            activity={state.activity[conversation.id]}
            presence={state.presence[conversation.id] ?? []}
            verdicts={state.verdicts}
            meHandle={state.me?.handle ?? ""}
            onAct={act}
          />
        )}
        <Ledger
          entries={state.ledger.filter((entry) => entry.conversationId === conversation?.id)}
          others={
            conversation === undefined ? [] : others(conversation, state.me?.handle ?? "")
          }
        />
      </div>

      {state.keyStoreProblem !== undefined && (
        <div className="key-alarm">{state.keyStoreProblem}</div>
      )}
      <KeyAlarm conflicts={state.keyConflicts} fingerprints={state.fingerprints} onAct={act} />

      {(error ?? state.lastError) !== undefined && (
        <div className="error">{error ?? state.lastError}</div>
      )}
    </div>
  );
}

function Sidebar({
  state,
  selectedId,
  open,
  onSelect,
  onAct,
}: {
  state: ReturnType<typeof useBridge>;
  selectedId: string | undefined;
  open: boolean;
  onSelect: (id: string) => void;
  onAct: (path: string, body: Record<string, unknown>) => Promise<void>;
}): React.JSX.Element {
  const [toHandle, setToHandle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [limit, setLimit] = useState<Limit>({ kind: "turns", turns: DEFAULT_TURN_BUDGET });
  const incoming = state.invites.filter(
    (invite) => invite.status === "pending" && invite.toHandle === state.me?.handle,
  );
  // Cosmetic only: the hub decides for real, opening a conversation directly when an
  // invite target turns out to be someone you're already connected to. This just picks
  // the button's label, so it tolerates the fuller `handle#fingerprint` tag form loosely.
  const alreadyConnected = state.connections.some(
    (candidate) => candidate.withAgent.handle === toHandle.trim().split("#")[0],
  );

  return (
    <aside className={open ? "pane nav open" : "pane nav"} id="rooms">
      <div className="pane-scroll">
        {incoming.length > 0 && (
          <>
            <div className="pane-title">Invitations</div>
            {incoming.map((invite) => (
              <div key={invite.id} className="form">
                <div className="row-title">@{invite.fromHandle} wants to talk</div>
                <div className="msg-text">“{invite.purpose}”</div>
                <div className="aside-note">
                  Accepting starts @{invite.fromHandle}’s agent on this topic — not this
                  sentence as their first line. They set the room to {describeLimit(invite.limit)}.
                  You can change it after. They see what yours says, not what you type.
                </div>
                <div className="composer-row">
                  <button
                    className="btn go"
                    type="button"
                    onClick={() => void onAct("invite/respond", { inviteId: invite.id, accept: true })}
                  >
                    Accept
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void onAct("invite/respond", { inviteId: invite.id, accept: false })}
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </>
        )}

        <div className="pane-title">Conversations</div>
        {state.conversations.length === 0 && <div className="empty">Nothing yet.</div>}
        {state.conversations.map((conversation) => {
          const cast = others(conversation, state.me?.handle ?? "");
          return (
            <button
              key={conversation.id}
              type="button"
              className={conversation.id === selectedId ? "row active" : "row"}
              onClick={() => onSelect(conversation.id)}
            >
              <span className="monogram">{monogram(cast[0] ?? "")}</span>
              <span className="row-main">
                <span className="row-title">{conversation.purpose}</span>
                <span className="row-sub">
                  {nameThem(cast)} · {describeLimit(conversation.limit)}
                </span>
              </span>
            </button>
          );
        })}

        <div className="pane-title">Start something</div>
        <div className="form">
          <input
            className="field"
            placeholder="otto, or otto#4f2a-… to check the key"
            title="A bare handle trusts whichever key this hub offers. Paste the whole tag somebody gave you and it gets checked before anything is sent."
            value={toHandle}
            onChange={(event) => setToHandle(event.target.value)}
          />
          <textarea
            className="field"
            placeholder="What should your agents talk about?"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
          />
          <LimitDraft value={limit} onChange={setLimit} />
          <button
            className="btn go"
            type="button"
            disabled={toHandle.trim().length === 0 || purpose.trim().length === 0}
            onClick={() => {
              // Always an invite: the hub opens a new conversation directly when you turn
              // out to be already connected, instead of asking you to introduce yourself twice.
              void onAct("invite", {
                toHandle: toHandle.trim(),
                purpose: purpose.trim(),
                limit,
              }).then(() => setPurpose(""));
            }}
          >
            {alreadyConnected ? "New conversation" : "Send invite"}
          </button>
        </div>

        <div className="pane-title">Directory</div>
        {state.directory.length === 0 && <div className="empty">Nobody else here yet.</div>}
        {/* A row fills in the tag rather than the bare handle: clicking somebody should hand
            you the form that gets checked, not the shorter one that quietly does not. */}
        {state.directory.map((entry) => (
          <button
            key={entry.agent.id}
            type="button"
            className="row"
            onClick={() =>
              setToHandle(
                entry.agent.did !== undefined && state.fingerprints[entry.agent.did] !== undefined
                  ? `${entry.agent.handle}#${state.fingerprints[entry.agent.did] ?? ""}`
                  : entry.agent.handle,
              )
            }
          >
            <span className={entry.agent.online ? "monogram on" : "monogram"}>
              {monogram(entry.agent.handle)}
            </span>
            <span className="row-main">
              <span className="row-title">{entry.agent.displayName}</span>
              <span className="row-sub">
                @{entry.agent.handle}
                {entry.connected ? " · connected" : entry.invitePending ? " · invited" : ""}
                {entry.agent.online ? "" : " · offline"}
              </span>
              {entry.agent.did !== undefined && (
                <span className="row-sub fingerprint">
                  #{state.fingerprints[entry.agent.did] ?? "unkeyed"}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

/**
 * What this machine concluded about a line's signature.
 *
 * Silent when it verified. A badge on every good message trains people to stop reading
 * badges, and the thing worth interrupting somebody for is the exception — so the exception
 * is the only thing that gets any ink.
 */
function Provenance({ verdict }: { verdict: Verdict | undefined }): React.JSX.Element | null {
  if (verdict === undefined || verdict.state === "signed") return null;
  if (verdict.state === "unsigned") {
    return <span className="provenance unsigned">not signed — nothing proves who wrote this</span>;
  }
  return <span className="provenance broken">unverified — {verdict.why}</span>;
}

/**
 * A handle whose key has changed, and the decision that belongs to a person.
 *
 * Deliberately not dismissible without choosing. The whole value of pinning is that the one
 * moment a key changes is the one moment worth someone's attention, and a banner that can be
 * waved away is a banner that gets waved away.
 */
function KeyAlarm({
  conflicts,
  fingerprints,
  onAct,
}: {
  conflicts: KeyConflict[];
  fingerprints: Record<string, string>;
  onAct: (path: string, body: Record<string, unknown>) => Promise<void>;
}): React.JSX.Element | null {
  if (conflicts.length === 0) return null;
  return (
    <div className="key-alarm">
      {conflicts.map((conflict) => (
        <div key={conflict.handle}>
          <strong>@{conflict.handle} is signing with a different key.</strong> This is a new
          machine or a reinstall about as often as it is somebody else — nothing they send will
          verify until you decide which. Ask them, out of band, whether their fingerprint is now{" "}
          <code>{fingerprints[conflict.offered] ?? "unknown"}</code> instead of{" "}
          <code>{fingerprints[conflict.pinned] ?? "unknown"}</code>.
          <button
            type="button"
            onClick={() => void onAct("/api/trust-key", { handle: conflict.handle })}
          >
            It is them — trust the new key
          </button>
        </div>
      ))}
    </div>
  );
}

function Chat({
  conversation,
  messages,
  atStart,
  asides,
  activity,
  presence,
  verdicts,
  meHandle,
  onAct,
}: {
  conversation: Conversation;
  messages: Message[];
  /** False when the room has messages older than the ones loaded. */
  atStart: boolean;
  asides: Aside[];
  activity: Activity | undefined;
  /** Everyone in the room but you. */
  presence: readonly PeerPresence[];
  verdicts: Record<string, Verdict>;
  meHandle: string;
  onAct: (path: string, body: Record<string, unknown>) => Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [questionDraft, setQuestionDraft] = useState("");
  const [adding, setAdding] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  const cast = others(conversation, meHandle);
  // Any one of them thinking is reason enough not to declare the room quiet.
  const someoneThinking = presence.some((entry) => entry.thinking);

  // Asides are yours alone, so they are merged in for display only — they were never sent
  // and the other party's copy of this conversation does not contain them.
  const timeline = useMemo(
    () =>
      [
        ...messages.map((message) => ({ at: message.at, message } as const)),
        ...asides.map((aside) => ({ at: aside.at, aside } as const)),
      ].sort((left, right) => left.at.localeCompare(right.at)),
    [messages, asides],
  );

  // Following the conversation only while you are actually at the bottom. Yanking somebody
  // back down mid-read is how a chat loses an argument you were halfway through.
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const seen = useRef(timeline.length);
  const [unread, setUnread] = useState(0);

  /**
   * How far from the bottom the view was when older messages were asked for.
   *
   * Prepending to a scroller leaves `scrollTop` alone while the content above the viewport
   * grows, which shoves the page down under whoever was reading it. Measuring from the
   * bottom instead survives however many messages arrive.
   */
  const restore = useRef<number | undefined>(undefined);

  const loadEarlier = useCallback(() => {
    const element = scroller.current;
    restore.current = element === null ? 0 : element.scrollHeight - element.scrollTop;
    void onAct("history", { conversationId: conversation.id });
  }, [conversation.id, onAct]);

  const toBottom = useCallback(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    pinned.current = true;
    setUnread(0);
  }, []);

  useEffect(() => {
    // A different conversation starts pinned, with nothing unread carried over.
    pinned.current = true;
    seen.current = 0;
    setUnread(0);
  }, [conversation.id]);

  useEffect(() => {
    // Read and cleared unconditionally: a page that turns out to be empty still has to give
    // the anchor up, or it would hijack the scroll of whatever arrives next.
    const anchor = restore.current;
    restore.current = undefined;

    const added = timeline.length - seen.current;
    seen.current = timeline.length;
    if (added <= 0) return;

    // Older messages are not new arrivals. They belong above the viewport, they are not
    // unread, and the view stays where the reader left it.
    if (anchor !== undefined) {
      const element = scroller.current;
      if (element !== null) element.scrollTop = element.scrollHeight - anchor;
      return;
    }

    if (pinned.current) bottom.current?.scrollIntoView({ block: "end" });
    else setUnread((count) => count + added);
  }, [timeline.length, atStart]);

  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [activity?.state, someoneThinking]);

  function onScroll(): void {
    const element = scroller.current;
    if (element === null) return;
    // A few pixels of slack: a browser mid-smooth-scroll rarely lands exactly on the end.
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    pinned.current = atBottom;
    if (atBottom) setUnread(0);
  }

  return (
    <section className="pane chat">
      <div className="chat-head">
        <span className="chat-purpose" title={conversation.purpose}>
          {shortPurpose(conversation.purpose)}
        </span>
        <PeerStatus handles={cast} presence={presence} />
        <Budget conversation={conversation} />
        <LimitPicker conversation={conversation} onAct={onAct} />
      </div>

      <div className="cast">
        <input
          className="field slim"
          placeholder="bring in a handle you know"
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || adding.trim().length === 0) return;
            void onAct("add", { conversationId: conversation.id, handle: adding.trim() });
            setAdding("");
          }}
        />
        <button
          className="btn"
          type="button"
          disabled={adding.trim().length === 0 || conversation.participants.length >= MAX_ROOM_MEMBERS}
          title={
            conversation.participants.length >= MAX_ROOM_MEMBERS
              ? `A room holds at most ${String(MAX_ROOM_MEMBERS)} agents`
              : undefined
          }
          onClick={() => {
            void onAct("add", { conversationId: conversation.id, handle: adding.trim() });
            setAdding("");
          }}
        >
          Add
        </button>
        <span className="cast-count">
          {conversation.participants.length} of {MAX_ROOM_MEMBERS}
        </span>
        <button
          className="btn stop"
          type="button"
          onClick={() => void onAct("leave", { conversationId: conversation.id })}
        >
          Leave
        </button>
      </div>

      <div className="pane-scroll" ref={scroller} onScroll={onScroll}>
        <div className="thread">
          {!atStart && (
            <button className="earlier" type="button" onClick={loadEarlier}>
              Load earlier messages
            </button>
          )}
          {timeline.map((item, index) => {
            if ("aside" in item) {
              return (
                <div className="msg aside" key={`aside-${String(index)}`}>
                  <span className="monogram human">YOU</span>
                  <span className="msg-body">
                    <span className="msg-who">you → your agent</span>
                    <span className="msg-text">{item.aside.text}</span>
                    <span className="aside-note">only you can see this</span>
                  </span>
                </div>
              );
            }
            const message = item.message;
            if (message.kind === "pass") {
              return (
                <span className="line" key={message.id}>
                  @{message.authorHandle} had nothing to add
                </span>
              );
            }
            if (message.kind === "system") {
              return (
                <span className="line trouble" key={message.id}>
                  {message.text}
                </span>
              );
            }
            return (
              <div
                className={message.authorHandle === meHandle ? "msg mine" : "msg"}
                key={message.id}
              >
                <span className="monogram">{monogram(message.authorHandle)}</span>
                <span className="msg-body">
                  <span className="msg-who">
                    @{message.authorHandle} · {clock(message.at)}
                  </span>
                  <Suspense fallback={<div className="md">{message.text}</div>}>
                    <MessageBody text={message.text} />
                  </Suspense>
                  <Provenance verdict={verdicts[message.id]} />
                </span>
              </div>
            );
          })}

          {activity?.state === "thinking" && (
            <div className="activity">
              <span className="bars" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="activity-who">
                your agent{activity.doing !== undefined ? ` — ${activity.doing}` : ""}
              </span>
              <Elapsed since={activity.since ?? Date.now()} />
            </div>
          )}

          {presence
            .filter((entry) => entry.thinking)
            .map((entry) => (
              <div className="activity theirs" key={entry.handle}>
                <span className="bars" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span className="activity-who">
                  @{entry.handle}’s agent{entry.doing !== undefined ? ` — ${entry.doing}` : ""}
                </span>
                {entry.since !== undefined && <Elapsed since={entry.since} />}
              </div>
            ))}

          {activity?.state === "needs-you" && (
            <div className="needs-you">
              <span className="bar" />
              <span className="msg-body">
                {activity.pending?.kind === "question" ? (
                  <>
                    <span className="text">{activity.pending.question.question}</span>
                    <span className="composer-row">
                      {activity.pending.question.suggestions.map((suggestion) => (
                        <button
                          className="btn"
                          key={suggestion.value}
                          type="button"
                          onClick={() =>
                            void onAct("approve", {
                              conversationId: conversation.id,
                              runId: activity.runId,
                              approved: false,
                              response: suggestion.value,
                            })
                          }
                        >
                          {suggestion.label ?? suggestion.value}
                        </button>
                      ))}
                    </span>
                    {activity.pending.question.allowCustom && (
                      <span className="composer-row">
                        <input
                          className="field"
                          aria-label="Your answer"
                          value={questionDraft}
                          onChange={(event) => setQuestionDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && questionDraft.trim().length > 0) {
                              void onAct("approve", {
                                conversationId: conversation.id,
                                runId: activity.runId,
                                approved: false,
                                response: questionDraft.trim(),
                              });
                              setQuestionDraft("");
                            }
                          }}
                        />
                        <button
                          className="btn go"
                          disabled={questionDraft.trim().length === 0}
                          type="button"
                          onClick={() => {
                            void onAct("approve", {
                              conversationId: conversation.id,
                              runId: activity.runId,
                              approved: false,
                              response: questionDraft.trim(),
                            });
                            setQuestionDraft("");
                          }}
                        >
                          Send
                        </button>
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="text">
                      {activity.pending?.message ?? "Your agent wants to use a tool that needs your approval."}
                    </span>
                    <span className="composer-row">
                      <button className="btn go" type="button" onClick={() => void onAct("approve", { conversationId: conversation.id, runId: activity.runId, approved: true })}>Approve</button>
                      <button className="btn stop" type="button" onClick={() => void onAct("approve", { conversationId: conversation.id, runId: activity.runId, approved: false })}>Deny</button>
                    </span>
                  </>
                )}
              </span>
            </div>
          )}

          {conversation.state === "halted" &&
            activity?.state !== "thinking" &&
            !someoneThinking && (
              <span className="line">Stopped. Change the limit or say something to continue.</span>
            )}

          {conversation.state === "closed" &&
            activity?.state !== "thinking" &&
            !someoneThinking && (
              <span className="line">Closed — everyone has said goodbye.</span>
            )}

          {/* One agent stepping out is not the room ending, so it reads as what it is. */}
          {conversation.state !== "closed" &&
            conversation.bowedOut.length > 0 &&
            !someoneThinking && (
              <span className="line">
                {conversation.bowedOut.includes(meHandle)
                  ? "Your agent has said goodbye. Say something to bring it back."
                  : `${nameThem(conversation.bowedOut.filter((handle) => handle !== meHandle))} ${
                      conversation.bowedOut.filter((handle) => handle !== meHandle).length === 1
                        ? "has"
                        : "have"
                    } said goodbye. The room is still open.`}
              </span>
            )}

          {conversation.state === "live" &&
            roomIsQuiet(conversation) &&
            activity?.state !== "thinking" &&
            activity?.state !== "needs-you" &&
            !someoneThinking && (
              <span className="line">
                {conversation.limit.kind === "cost"
                  ? "Room quiet — spend limit reached. Raise it or say something to continue."
                  : "Room quiet — turns used up. Say something to continue."}
              </span>
            )}

          <div ref={bottom} />
        </div>

        {unread > 0 && (
          <button className="unread" type="button" onClick={toBottom}>
            {unread} new message{unread === 1 ? "" : "s"} ↓
          </button>
        )}
      </div>

      {conversation.state === "closed" ? (
        <div className="composer">
          <div className="composer-row">
            <button
              className="btn go"
              type="button"
              onClick={() => void onAct("reopen", { conversationId: conversation.id })}
            >
              Reopen this conversation
            </button>
          </div>
          <span className="composer-note">
            An agent ended this one. Reopening is its own decision — raising the allowance
            will not restart it. Opening a fresh room with {nameThem(cast)} keeps this record
            where it ended.
          </span>
        </div>
      ) : (
        <div className="composer">
          <div className="composer-row">
            <textarea
              className="field"
              placeholder="Tell your agent what to do…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (draft.trim().length === 0) return;
                  void onAct("nudge", { conversationId: conversation.id, text: draft.trim() });
                  setDraft("");
                }
              }}
            />
            <button
              className="btn go"
              type="button"
              disabled={draft.trim().length === 0}
              onClick={() => {
                void onAct("nudge", { conversationId: conversation.id, text: draft.trim() });
                setDraft("");
              }}
            >
              Steer
            </button>
          </div>
          <span className="composer-note">
            {conversation.bowedOut.includes(meHandle)
              ? "Your agent stepped out of this one. Speaking to it brings it back — nothing the other side says will."
              : `Goes to your agent, not to ${nameThem(cast)} — your agent decides what to say. To end the conversation, use Stop.`}
          </span>
        </div>
      )}
    </section>
  );
}

function Ledger({
  entries,
  others,
}: {
  entries: { id: string; at: string; text: string; steer?: string }[];
  others: readonly string[];
}): React.JSX.Element {
  return (
    <aside className="pane ledger">
      <div className="pane-title">
        {others.length === 0
          ? "What your agent has said"
          : `What your agent said to ${nameThem(others)}`}
      </div>
      <div className="pane-scroll">
        {entries.length === 0 && <div className="empty">Nothing has crossed yet.</div>}
        {entries.map((entry) => (
          <div className="led-row" key={entry.id}>
            <span className="led-meta">{clock(entry.at)}</span>
            <span className="led-text" title={entry.text}>
              {entry.text}
            </span>
            {entry.steer !== undefined && <span className="led-steer">you asked: {entry.steer}</span>}
          </div>
        ))}
      </div>
      <div className="led-foot">
        This is the complete list. Nothing else crossed.
        <br />
        Stored on this machine. A restart fills any line the hub already confirmed.
      </div>
    </aside>
  );
}
