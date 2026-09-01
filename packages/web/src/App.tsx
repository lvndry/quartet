import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, Message } from "@quartet/protocol";
import { MAX_SPEND_USD, MAX_TURN_BUDGET } from "@quartet/protocol";
import { call, useBridge, useSocketLive, type Activity, type Aside, type Limit } from "./store";

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

/**
 * The same warning the agents are given, shown to the people watching.
 *
 * They are the ones who would raise the limit, so knowing the room is nearly out matters
 * before it goes quiet rather than after.
 */
function nearingLimit(conversation: Conversation): string | undefined {
  const { limit, budgetRemaining, spentUSD, spendIncomplete } = conversation;
  if (conversation.stopped) return undefined;
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
          : { kind: "turns", turns: 20 };
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

      <button
        className="btn stop"
        type="button"
        onClick={() => void onAct("stop", { conversationId: conversation.id })}
      >
        Stop
      </button>
    </span>
  );
}
export default function App(): React.JSX.Element {
  const state = useBridge();
  const live = useSocketLive();
  const [selected, setSelected] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const conversation: Conversation | undefined = useMemo(
    () =>
      state.conversations.find((candidate) => candidate.id === selected) ?? state.conversations[0],
    [state.conversations, selected],
  );

  async function act(path: string, body: Record<string, unknown>): Promise<void> {
    setError(await call(path, body));
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          Quar<span>tet</span>
        </div>
        {state.me !== undefined && <span className="whoami">@{state.me.handle}</span>}
        <div className="spacer" />
        <span className={live && state.connectedToHub ? "status live" : "status"}>
          <span className="pip" />
          {!live ? "bridge offline" : state.connectedToHub ? "connected" : "reaching the hub"}
        </span>
      </header>

      <div className="columns">
        <Sidebar
          state={state}
          selectedId={conversation?.id}
          onSelect={setSelected}
          onAct={act}
        />
        {conversation === undefined ? (
          <section className="pane">
            <div className="placeholder">
              <p>
                No conversations yet. Find someone in the directory and invite them — the line
                you write is what your agents start talking about.
              </p>
            </div>
          </section>
        ) : (
          <Chat
            conversation={conversation}
            messages={state.messages[conversation.id] ?? []}
            asides={state.asides[conversation.id] ?? []}
            activity={state.activity[conversation.id]}
            meHandle={state.me?.handle ?? ""}
            onAct={act}
          />
        )}
        <Ledger
          entries={state.ledger.filter((entry) => entry.conversationId === conversation?.id)}
          other={conversation?.participants.find((handle) => handle !== state.me?.handle)}
        />
      </div>

      {(error ?? state.lastError) !== undefined && (
        <div className="error">{error ?? state.lastError}</div>
      )}
    </div>
  );
}

function Sidebar({
  state,
  selectedId,
  onSelect,
  onAct,
}: {
  state: ReturnType<typeof useBridge>;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onAct: (path: string, body: Record<string, unknown>) => Promise<void>;
}): React.JSX.Element {
  const [toHandle, setToHandle] = useState("");
  const [purpose, setPurpose] = useState("");
  const incoming = state.invites.filter(
    (invite) => invite.status === "pending" && invite.toHandle === state.me?.handle,
  );

  return (
    <aside className="pane">
      <div className="pane-scroll">
        {incoming.length > 0 && (
          <>
            <div className="pane-title">Invitations</div>
            {incoming.map((invite) => (
              <div key={invite.id} className="form">
                <div className="row-title">@{invite.fromHandle} wants to talk</div>
                <div className="msg-text">“{invite.purpose}”</div>
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
          const other =
            conversation.participants.find((handle) => handle !== state.me?.handle) ?? "";
          return (
            <button
              key={conversation.id}
              type="button"
              className={conversation.id === selectedId ? "row active" : "row"}
              onClick={() => onSelect(conversation.id)}
            >
              <span className="monogram">{monogram(other)}</span>
              <span className="row-main">
                <span className="row-title">{conversation.purpose}</span>
                <span className="row-sub">
                  @{other} · {describeLimit(conversation.limit)}
                </span>
              </span>
            </button>
          );
        })}

        <div className="pane-title">Start something</div>
        <div className="form">
          <input
            className="field"
            placeholder="handle, e.g. otto"
            value={toHandle}
            onChange={(event) => setToHandle(event.target.value)}
          />
          <textarea
            className="field"
            placeholder="What should your agents talk about?"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
          />
          <button
            className="btn go"
            type="button"
            disabled={toHandle.trim().length === 0 || purpose.trim().length === 0}
            onClick={() => {
              const connection = state.connections.find(
                (candidate) => candidate.withAgent.handle === toHandle.trim(),
              );
              // Already connected? Then this is a new conversation, not another invite —
              // you introduce yourself once, and talk as many times as you like after that.
              void onAct(
                connection !== undefined ? "conversation" : "invite",
                connection !== undefined
                  ? { connectionId: connection.id, purpose: purpose.trim() }
                  : { toHandle: toHandle.trim(), purpose: purpose.trim() },
              ).then(() => setPurpose(""));
            }}
          >
            {state.connections.some((candidate) => candidate.withAgent.handle === toHandle.trim())
              ? "New conversation"
              : "Send invite"}
          </button>
        </div>

        <div className="pane-title">Directory</div>
        {state.directory.length === 0 && <div className="empty">Nobody else here yet.</div>}
        {state.directory.map((entry) => (
          <button
            key={entry.agent.id}
            type="button"
            className="row"
            onClick={() => setToHandle(entry.agent.handle)}
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
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function Chat({
  conversation,
  messages,
  asides,
  activity,
  meHandle,
  onAct,
}: {
  conversation: Conversation;
  messages: Message[];
  asides: Aside[];
  activity: Activity | undefined;
  meHandle: string;
  onAct: (path: string, body: Record<string, unknown>) => Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

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
    const added = timeline.length - seen.current;
    seen.current = timeline.length;
    if (added <= 0) return;
    if (pinned.current) bottom.current?.scrollIntoView({ block: "end" });
    else setUnread((count) => count + added);
  }, [timeline.length]);

  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [activity?.state]);

  function onScroll(): void {
    const element = scroller.current;
    if (element === null) return;
    // A few pixels of slack: a browser mid-smooth-scroll rarely lands exactly on the end.
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    pinned.current = atBottom;
    if (atBottom) setUnread(0);
  }

  return (
    <section className="pane">
      <div className="chat-head">
        <span className="chat-purpose" title={conversation.purpose}>
          {shortPurpose(conversation.purpose)}
        </span>
        <Budget conversation={conversation} />
        <LimitPicker conversation={conversation} onAct={onAct} />
      </div>

      <div className="pane-scroll" ref={scroller} onScroll={onScroll}>
        <div className="thread">
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
                  <span className="msg-text">{message.text}</span>
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
              <Elapsed since={activity.since ?? Date.now()} />
            </div>
          )}

          {activity?.state === "needs-you" && (
            <div className="needs-you">
              <span className="bar" />
              <span className="msg-body">
                <span className="text">Your agent wants to use a tool that needs your approval.</span>
                <span className="hint">jazz runs answer {activity.runId}</span>
              </span>
            </div>
          )}

          {conversation.stopped && activity?.state !== "thinking" && (
            <span className="line">Stopped. Change the limit or say something to continue.</span>
          )}

          {!conversation.stopped &&
            conversation.limit.kind !== "none" &&
            conversation.budgetRemaining === 0 &&
            activity?.state !== "thinking" && (
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
            Send
          </button>
        </div>
        <span className="composer-note">
          Goes to your agent, not to @
          {conversation.participants.find((handle) => handle !== meHandle) ?? "them"} — your agent
          decides what to say. To end the conversation, use Stop.
        </span>
      </div>
    </section>
  );
}

function Ledger({
  entries,
  other,
}: {
  entries: { id: string; at: string; text: string; steer?: string }[];
  other: string | undefined;
}): React.JSX.Element {
  return (
    <aside className="pane">
      <div className="pane-title">
        {other === undefined ? "What your agent has said" : `Everything you've told @${other}`}
      </div>
      <div className="pane-scroll">
        {entries.length === 0 && <div className="empty">Nothing has crossed yet.</div>}
        {entries.map((entry) => (
          <div className="led-row" key={entry.id}>
            <span className="led-meta">{clock(entry.at)}</span>
            <span className="led-text">{entry.text}</span>
            {entry.steer !== undefined && <span className="led-steer">you asked: {entry.steer}</span>}
          </div>
        ))}
      </div>
      <div className="led-foot">
        This is the complete list. Nothing else crossed.
        <br />
        Stored on this machine — the hub never receives it.
      </div>
    </aside>
  );
}
