/**
 * @fileoverview The app's only connection to anything: one socket to the local bridge.
 *
 * The bridge pushes its whole state on every change rather than a stream of deltas. For a
 * two-person conversation that is a few kilobytes, and it buys the absence of a second
 * incremental protocol that could drift out of step with the first. When conversations get
 * big enough for that to hurt, the fix is paging the transcript, not inventing deltas.
 */

import { useSyncExternalStore } from "react";
import type { BridgeState } from "@quartet/protocol";
export type { Limit, PeerPresence } from "@quartet/protocol";

/**
 * Every shape in a snapshot, from the one place it is defined.
 *
 * These used to be re-declared here by hand, so a field renamed on one side only would have
 * rendered `undefined` rather than failing to compile. `Conflict` keeps the app's own name
 * for it, which reads better beside `keyConflicts`.
 */
export type {
  Activity,
  Aside,
  BridgeState,
  HumanQuestion,
  JazzAgent,
  JazzAgentDetail,
  JazzCatalog,
  JazzModel,
  JazzPersona,
  JazzProblem,
  JazzTools,
  LedgerEntry,
  ToolCall,
  Verdict,
} from "@quartet/protocol";
export type { Conflict as KeyConflict } from "@quartet/protocol";

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
  toolCalls: {},
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
 * {@link call} throws the body away, because the snapshot is how a result arrives. This is for
 * the few reads deliberately kept out of the snapshot — model lists, catalogues, one agent's
 * config — which are cheaper to fetch when a form is open than to push to every browser.
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
