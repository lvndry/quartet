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
  runId?: string;
}

export interface Aside {
  at: string;
  conversationId: string;
  text: string;
}

export interface LedgerEntry {
  id: string;
  at: string;
  conversationId: string;
  to: string;
  text: string;
  steer?: string;
}

export interface BridgeState {
  connectedToHub: boolean;
  me?: Agent;
  connections: Connection[];
  conversations: Conversation[];
  invites: Invite[];
  directory: DirectoryEntry[];
  messages: Record<string, Message[]>;
  asides: Record<string, Aside[]>;
  activity: Record<string, Activity>;
  presence: Record<string, PeerPresence>;
  ledger: LedgerEntry[];
  lastError?: string;
}

const EMPTY: BridgeState = {
  connectedToHub: false,
  connections: [],
  conversations: [],
  invites: [],
  directory: [],
  messages: {},
  asides: {},
  activity: {},
  presence: {},
  ledger: [],
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
