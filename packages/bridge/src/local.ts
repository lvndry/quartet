/**
 * @fileoverview The app, served from your own machine.
 *
 * Loopback only, and guarded by a token printed at startup — the same shape jazz's own
 * daemon uses, and for the same reason: a port on localhost is reachable by every page in
 * your browser, so "it's only local" is not by itself a security property. The `Origin`
 * check is what stops a site you happen to be visiting from driving your agent.
 */

import { limitSchema } from "@quartet/protocol";
import type { Bridge, BridgeState } from "./bridge";
import type { ServerWebSocket } from "bun";

/** How many ports above the preferred one to try before giving up. */
const PORT_SCAN_ATTEMPTS = 20;

export interface LocalServerOptions {
  /** Preferred port. The next free one above it is used when this is taken. */
  readonly port: number;
  readonly token: string;
  readonly bridge: Bridge;
  /** Directory holding the built web app. Absent in development, where Vite serves it. */
  readonly webRoot?: string;
}

interface BrowserSocket {
  authorized: boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Only this machine, and only pages we served.
 *
 * A missing `Origin` is allowed because non-browser callers (curl, the CLI's own health
 * check) do not send one, and they are not the threat here — a cross-site request always
 * carries one.
 */
function originAllowed(request: Request, port: number): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    const url = new URL(origin);
    return (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.port === String(port)
    );
  } catch {
    return false;
  }
}

function presentedToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return new URL(request.url).searchParams.get("token") ?? "";
}

/**
 * Serve the app on the first free port at or above the preferred one.
 *
 * Scanning means a second agent on the same host needs no port flag: it finds 7778 on its
 * own and remembers it. The `Origin` check reads the bound port rather than the requested
 * one, so a page served from 7778 is still recognised as ours.
 */
export function startLocalServer(options: LocalServerOptions): { port: number; stop: () => void } {
  const browsers = new Set<ServerWebSocket<BrowserSocket>>();

  const unsubscribe = options.bridge.subscribe((state: BridgeState) => {
    const payload = JSON.stringify({ t: "state", state });
    for (const socket of browsers) {
      if (socket.data.authorized) socket.send(payload);
    }
  });

  let boundPort = options.port;

  const serve = (port: number) => Bun.serve<BrowserSocket, never>({
    port,
    hostname: "127.0.0.1",
    async fetch(request, bunServer) {
      const url = new URL(request.url);

      if (!originAllowed(request, boundPort)) {
        return json({ error: "cross-origin requests are not accepted here" }, 403);
      }

      if (url.pathname === "/socket") {
        if (presentedToken(request) !== options.token) {
          return new Response("unauthorized", { status: 401 });
        }
        return bunServer.upgrade(request, { data: { authorized: true } })
          ? undefined
          : new Response("expected a websocket upgrade", { status: 426 });
      }

      if (url.pathname.startsWith("/api/")) {
        if (presentedToken(request) !== options.token) return json({ error: "unauthorized" }, 401);
        return handleApi(url.pathname, request, options.bridge);
      }

      // Everything else is the app itself. In development there is no build to serve, so the
      // CLI says so rather than pretending a blank page is working.
      if (options.webRoot === undefined) {
        return new Response(
          "quartet: no web build found. Run `bun run web:build`, or `bun run web:dev` for the dev server.",
          { status: 503, headers: { "content-type": "text/plain" } },
        );
      }
      const requested = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(`${options.webRoot}${requested}`);
      if (await file.exists()) return new Response(file);
      // Unknown paths fall back to the shell so client-side routing works on a hard refresh.
      return new Response(Bun.file(`${options.webRoot}/index.html`));
    },
    websocket: {
      open(socket) {
        browsers.add(socket);
        socket.send(JSON.stringify({ t: "state", state: options.bridge.snapshot() }));
      },
      message() {
        // The browser drives the bridge over the HTTP API; the socket is push-only. Keeping
        // it one-directional means there is exactly one place a browser action is authorized.
      },
      close(socket) {
        browsers.delete(socket);
      },
    },
  });

  let server: ReturnType<typeof serve> | undefined;
  for (let attempt = 0; attempt < PORT_SCAN_ATTEMPTS; attempt += 1) {
    boundPort = options.port + attempt;
    try {
      server = serve(boundPort);
      break;
    } catch (error) {
      const inUse = (error as { code?: string }).code === "EADDRINUSE";
      if (!inUse || attempt === PORT_SCAN_ATTEMPTS - 1) throw error;
    }
  }
  if (server === undefined) throw new Error("could not find a free port for the app");

  const running = server;
  return {
    port: Number(running.port),
    stop: () => {
      unsubscribe();
      running.stop(true);
    },
  };
}

async function handleApi(pathname: string, request: Request, bridge: Bridge): Promise<Response> {
  if (request.method !== "POST") return json({ error: "not found" }, 404);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return json({ error: "expected a JSON body" }, 400);

  const text = (key: string): string =>
    typeof body[key] === "string" ? (body[key] as string).trim() : "";

  switch (pathname) {
    case "/api/invite": {
      const toHandle = text("toHandle");
      const purpose = text("purpose");
      if (toHandle.length === 0 || purpose.length === 0) {
        return json({ error: "a handle and a purpose line are both required" }, 400);
      }
      bridge.send({ t: "invite.send", toHandle, purpose });
      return json({ ok: true });
    }

    case "/api/invite/respond": {
      const inviteId = text("inviteId");
      if (inviteId.length === 0) return json({ error: "inviteId is required" }, 400);
      bridge.send({ t: "invite.respond", inviteId, accept: body["accept"] === true });
      return json({ ok: true });
    }

    case "/api/conversation": {
      const connectionId = text("connectionId");
      const purpose = text("purpose");
      if (connectionId.length === 0 || purpose.length === 0) {
        return json({ error: "a connection and a purpose line are both required" }, 400);
      }
      bridge.send({ t: "conversation.open", connectionId, purpose });
      return json({ ok: true });
    }

    case "/api/nudge": {
      const conversationId = text("conversationId");
      const message = text("text");
      if (conversationId.length === 0 || message.length === 0) {
        return json({ error: "a conversation and some text are both required" }, 400);
      }
      bridge.nudge(conversationId, message);
      return json({ ok: true });
    }

    case "/api/limit": {
      const conversationId = text("conversationId");
      const limit = body["limit"];
      if (conversationId.length === 0 || typeof limit !== "object" || limit === null) {
        return json({ error: "a conversation and a limit are both required" }, 400);
      }
      const parsed = limitSchema.safeParse(limit);
      if (!parsed.success) {
        return json({ error: parsed.error.issues[0]?.message ?? "invalid limit" }, 400);
      }
      bridge.send({ t: "limit.set", conversationId, limit: parsed.data });
      return json({ ok: true });
    }

    case "/api/stop": {
      const conversationId = text("conversationId");
      if (conversationId.length === 0) return json({ error: "conversationId is required" }, 400);
      bridge.send({ t: "conversation.stop", conversationId });
      return json({ ok: true });
    }

    case "/api/approve": {
      const conversationId = text("conversationId");
      const runId = text("runId");
      if (conversationId.length === 0 || runId.length === 0) {
        return json({ error: "a conversation and a run are both required" }, 400);
      }
      const approved = body["approved"] === true;
      const note = text("note");
      await bridge.resolveApproval(
        conversationId,
        runId,
        approved,
        note.length > 0 ? note : undefined,
      );
      return json({ ok: true });
    }

    case "/api/directory": {
      bridge.send({ t: "directory.list" });
      return json({ ok: true });
    }

    default:
      return json({ error: "not found" }, 404);
  }
}
