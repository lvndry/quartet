/**
 * @fileoverview The app's only connection to anything: one socket to the local bridge.
 *
 * The bridge pushes its whole state on every change rather than a stream of deltas. For a
 * two-person conversation that is a few kilobytes, and it buys the absence of a second
 * incremental protocol that could drift out of step with the first. When conversations get
 * big enough for that to hurt, the fix is paging the transcript, not inventing deltas.
 */

import { useSyncExternalStore } from "react";
import type { Agent, Connection, Conversation, DirectoryEntry, Invite, Message, PeerPresence } from "@quartet/protocol";
export type { Limit, PeerPresence } from "@quartet/protocol";

export interface Activity {
  state: "idle" | "thinking" | "needs-you";
  since?: number;
  /** What the daemon last said the agent was doing. A tool name, not a thought. */
  doing?: string;
  runId?: string;
  pending?:
    | { kind: "approval"; message?: string }
    | {
        kind: "question";
        question: {
          question: string;
          suggestions: { value: string; label?: string; description?: string }[];
          allowCustom: boolean;
          allowMultiple: boolean;
        };
      };
}

export interface Aside {
  at: string;
  conversationId: string;
  text: string;
}

/** What this machine concluded about one message's signature. Mirrors the bridge's verdict. */
export type Verdict =
  | { state: "signed" }
  | { state: "unsigned" }
  | { state: "broken"; why: string };

/** A handle whose key changed since this machine first saw it. */
export interface KeyConflict {
  handle: string;
  pinned: string;
  offered: string;
}

export interface LedgerEntry {
  id: string;
  at: string;
  conversationId: string;
  to: string;
  text: string;
  steer?: string;
}

/** One of this machine's jazz agents, as the roster lists it. */
export interface JazzAgent {
  id: string;
  name: string;
  description?: string;
  provider?: string;
  model?: string;
  persona?: string;
  tools: string[];
}

export type JazzProblem = "unreachable" | "unauthorized" | "unsupported" | "failed";

/** The fixed vocabularies the editor's menus are built from. */
export interface JazzCatalog {
  providers: string[];
  webSearchProviders: string[];
  reasoningEfforts: string[];
}

/**
 * One model a provider serves, with the flags that decide which fields mean anything.
 *
 * A temperature input on a model that ignores temperature is a control that silently does
 * nothing — and every current Claude reasoning model reports `supportsTemperature: false`.
 */
export interface JazzModel {
  id: string;
  displayName?: string;
  supportsTools: boolean;
  supportsTemperature: boolean;
  isReasoningModel: boolean;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
}

export interface JazzPersona {
  id: string;
  name: string;
  description: string;
  tone?: string;
  style?: string;
}

/**
 * The tools an agent could be given.
 *
 * `defaultTools` is the load-bearing part: `config.tools` only ever *adds* to the built-in
 * bundle, so a checkbox beside a default tool would imply a permission it does not control.
 * Turning one of those off is `deniedTools`, a different field.
 */
export interface JazzTools {
  tools: string[];
  categories: Record<string, string[]>;
  /** Absent when this jazz is too old to say — not the same as nothing being on by default. */
  defaultTools?: string[];
}

/** One agent in full, for the editor. Api keys are never served, only which providers set one. */
export interface JazzAgentDetail {
  id: string;
  name: string;
  description?: string;
  persona: string;
  provider: string;
  model: string;
  tools: string[];
  config: Record<string, unknown>;
  apiKeyProviders: string[];
}

export interface BridgeState {
  connectedToHub: boolean;
  me?: Agent;
  /** `provider/model` for the jazz agent answering on this machine. */
  myModel?: string;
  /** This machine's jazz agents. Not hub agents — those are `directory`. */
  jazzAgents: JazzAgent[];
  /** Which of them speaks for you here. */
  myAgentId?: string;
  jazzProblem?: JazzProblem;
  /** The menus the agent editor is built from. Absent when this jazz cannot serve them. */
  jazzCatalog?: JazzCatalog;
  connections: Connection[];
  conversations: Conversation[];
  invites: Invite[];
  directory: DirectoryEntry[];
  messages: Record<string, Message[]>;
  /** Whether the oldest message held for a room really is the room's first. */
  atStart: Record<string, boolean>;
  asides: Record<string, Aside[]>;
  activity: Record<string, Activity>;
  /** Everyone in each room but you. */
  presence: Record<string, PeerPresence[]>;
  ledger: LedgerEntry[];
  verdicts: Record<string, Verdict>;
  keyConflicts: KeyConflict[];
  /** Readable short form of each key, by did. Derived by the bridge, never by the page. */
  fingerprints: Record<string, string>;
  keyStoreProblem?: string;
  lastError?: string;
}

const EMPTY: BridgeState = {
  connectedToHub: false,
  jazzAgents: [],
  connections: [],
  conversations: [],
  invites: [],
  directory: [],
  messages: {},
  atStart: {},
  asides: {},
  activity: {},
  presence: {},
  ledger: [],
  verdicts: {},
  keyConflicts: [],
  fingerprints: {},
};

const TOKEN_KEY = "quartet.token";

/**
 * The token the bridge printed.
 *
 * Kept in the address bar so the URL can be copied to another tab or browser, and stored so
 * a bare `http://localhost:7777` opens the app too. The bridge reuses the same token across
 * restarts, which is what makes either of those hold tomorrow.
 */
function readToken(): string {
  const fromUrl = new URL(window.location.href).searchParams.get("token");
  if (fromUrl !== null) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // A browser refusing storage still works for this tab; the URL carried the token.
    }
    return fromUrl;
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export const token = readToken();

let current: BridgeState = EMPTY;
let socketLive = false;
let currentSocket: WebSocket | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function connect(): void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(
    `${protocol}//${window.location.host}/socket?token=${encodeURIComponent(token)}`,
  );
  currentSocket = socket;

  socket.addEventListener("open", () => {
    socketLive = true;
    emit();
  });

  socket.addEventListener("message", (event) => {
    try {
      const parsed = JSON.parse(String(event.data)) as { t: string; state: BridgeState };
      if (parsed.t === "state") {
        current = parsed.state;
        emit();
      }
    } catch {
      // A frame we cannot read is a frame we ignore; the next snapshot supersedes it anyway.
    }
  });

  socket.addEventListener("close", () => {
    if (currentSocket !== socket) return;
    socketLive = false;
    emit();
    // The bridge is a local process — if it is gone the user restarted it, and it will be
    // back on the same port. A short fixed retry beats backoff for something on this machine.
    setTimeout(connect, 1000);
  });
}

connect();

/**
 * Stable across renders, deliberately.
 *
 * An inline `subscribe` makes React tear the subscription down and re-add it on every single
 * render, which leaves a window where a push lands with nobody listening — the symptom is a
 * UI that is correct on load and then quietly stops following the conversation. Hoisting it
 * to module scope means React subscribes once and stays subscribed.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const readState = (): BridgeState => current;
const readSocketLive = (): boolean => socketLive;

export function useBridge(): BridgeState {
  return useSyncExternalStore(subscribe, readState);
}

export function useSocketLive(): boolean {
  return useSyncExternalStore(subscribe, readSocketLive);
}

export async function call(path: string, body: Record<string, unknown>): Promise<string | undefined> {
  const response = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).catch(() => undefined);
  if (response === undefined) return "the bridge is not answering";
  if (response.ok) return undefined;
  const detail = (await response.json().catch(() => null)) as { error?: string } | null;
  return detail?.error ?? `request failed (${String(response.status)})`;
}

/**
 * What a refused request said, in enough detail to mark the input that caused it.
 *
 * `field` and `suggestion` come from jazz, through the bridge, untouched. A form that only
 * has a message has to show a banner; one that knows the field can put the message where the
 * mistake is.
 */
export interface Refusal {
  readonly error: string;
  readonly field?: string;
  readonly suggestion?: string;
}

/**
 * Ask the bridge for something and get the answer back.
 *
 * {@link call} is for actions and throws the body away on purpose, because the state snapshot
 * is how a result arrives. This is for the few reads that are deliberately *not* in the
 * snapshot — a provider's model list, the persona catalogue, one agent's whole config —
 * because pushing them to every browser on every change would cost far more than asking for
 * them when a form is actually open.
 */
export async function read<T>(
  path: string,
  body: Record<string, unknown> = {},
): Promise<{ readonly value: T } | { readonly refused: Refusal }> {
  const response = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).catch(() => undefined);

  if (response === undefined) {
    return { refused: { error: "the bridge is not answering" } };
  }
  const detail = (await response.json().catch(() => null)) as
    | { value?: T; error?: string; field?: string; suggestion?: string }
    | null;

  if (!response.ok || detail === null) {
    return {
      refused: {
        error: detail?.error ?? `request failed (${String(response.status)})`,
        ...(detail?.field !== undefined ? { field: detail.field } : {}),
        ...(detail?.suggestion !== undefined ? { suggestion: detail.suggestion } : {}),
      },
    };
  }
  return { value: detail.value as T };
}
