/**
 * @fileoverview The app's only connection to anything: one socket to the local bridge.
 *
 * The bridge pushes its whole state on every change rather than a stream of deltas. For a
 * two-person conversation that is a few kilobytes, and it buys the absence of a second
 * incremental protocol that could drift out of step with the first. When conversations get
 * big enough for that to hurt, the fix is paging the transcript, not inventing deltas.
 */

import { useSyncExternalStore } from "react";
import type { Agent, Connection, Conversation, DirectoryEntry, Invite, Message } from "@quartet/protocol";
export type { Limit } from "@quartet/protocol";

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
  ledger: [],
};

/**
 * The token the bridge printed, taken from the URL once and kept out of it afterwards.
 *
 * Stripping it from the address bar means it does not end up in a screenshot of the app,
 * which is a thing people are going to do with this.
 */
function readToken(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl !== null) {
    sessionStorage.setItem("quartet.token", fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.toString());
    return fromUrl;
  }
  return sessionStorage.getItem("quartet.token") ?? "";
}

export const token = readToken();

let current: BridgeState = EMPTY;
let socketLive = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function connect(): void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(
    `${protocol}//${window.location.host}/socket?token=${encodeURIComponent(token)}`,
  );

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
