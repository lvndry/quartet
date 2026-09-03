/**
 * @fileoverview The app, served from your own machine.
 *
 * Loopback only, and guarded by a token printed at startup — the same shape jazz's own
 * daemon uses, and for the same reason: a port on localhost is reachable by every page in
 * your browser, so "it's only local" is not by itself a security property. The `Origin`
 * check is what stops a site you happen to be visiting from driving your agent.
 */

import { limitSchema } from "@quartet/protocol";
import type { AgentAdmin } from "./agent-admin";
import type { Bridge, BridgeState } from "./bridge";
import type { JazzResult } from "./jazz-admin";
import type { ServerWebSocket } from "bun";

/** How many ports above the preferred one to try before giving up. */
const PORT_SCAN_ATTEMPTS = 20;

export interface LocalServerOptions {
  /** Port to serve on. Whether a taken one may be stepped over is `mayMoveUp`. */
  readonly port: number;
  /**
   * Whether a taken port may be stepped over for the next free one above it.
   *
   * True only when nobody named this port — a second agent on one host then finds its own
   * without needing a flag. A port that was asked for is served or not at all: quietly
   * moving means the URL you were given is not the one you asked for, and the wrong one
   * gets remembered for next time.
   */
  readonly mayMoveUp: boolean;
  readonly token: string;
  readonly bridge: Bridge;
  /** This machine's jazz agents, for the dashboard. */
  readonly agents: AgentAdmin;
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
 * Serve the app, on the first free port at or above the given one when `mayMoveUp` allows.
 *
 * Scanning means a second agent on the same host needs no port flag: it finds 7778 on its
 * own and remembers it. The `Origin` check reads the bound port rather than the requested
 * one, so a page served from 7778 is still recognised as ours. Without `mayMoveUp` a taken
 * port throws `EADDRINUSE` for the caller to report.
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

      // This machine's jazz daemon, reporting into a turn it was given a key for. It has
      // no browser token and is not a browser, so it authenticates with the one-time key in
      // the path — which is also what stops anything else on the port narrating the room.
      if (url.pathname.startsWith("/progress/")) {
        if (request.method !== "POST") return json({ error: "not found" }, 404);
        const key = url.pathname.slice("/progress/".length);
        const event = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (event === null) return json({ error: "expected a JSON body" }, 400);
        return options.bridge.onDaemonProgress(key, event)
          ? json({ ok: true })
          : json({ error: "no turn is waiting on that key" }, 404);
      }

      if (url.pathname.startsWith("/api/")) {
        if (presentedToken(request) !== options.token) return json({ error: "unauthorized" }, 401);
        return handleApi(url.pathname, request, options.bridge, options.agents);
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
  const attempts = options.mayMoveUp ? PORT_SCAN_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    boundPort = options.port + attempt;
    try {
      server = serve(boundPort);
      break;
    } catch (error) {
      const inUse = (error as { code?: string }).code === "EADDRINUSE";
      if (!inUse || attempt === attempts - 1) throw error;
    }
  }
  if (server === undefined) throw new Error("could not find a free port for the app");

  const running = server;
  // The daemon is told where to report only once the port is known, because it is whichever
  // one was free rather than the one that was asked for.
  options.bridge.setLocalOrigin(`http://127.0.0.1:${String(running.port)}`);
  return {
    port: Number(running.port),
    stop: () => {
      unsubscribe();
      running.stop(true);
    },
  };
}

/**
 * Turn jazz's answer into the app's.
 *
 * Every failure kind gets its own sentence, because a UI that collapses them says "something
 * went wrong" to somebody whose daemon simply is not running. A `rejected` carries jazz's own
 * `field` and `suggestion` straight through, so the form can mark the input that was wrong
 * rather than showing a banner — those are the reason jazz reports them at all.
 *
 * The status is 502 for everything that is jazz's state rather than the caller's mistake:
 * the request was fine, the thing behind it was not.
 */
function fromJazz<T>(result: JazzResult<T>): Response {
  switch (result.kind) {
    case "ok":
      return json({ ok: true, value: result.value });
    case "unreachable":
      return json({ error: "jazz is not answering. Start it with `jazz daemon`." }, 502);
    case "unauthorized":
      return json({ error: "jazz refused quartet's token. Re-run `quartet connect`." }, 502);
    case "unsupported":
      return json({ error: "this jazz is too old to manage agents from here. Update it." }, 502);
    case "rejected":
      return json(
        {
          error: result.error,
          ...(result.field !== undefined ? { field: result.field } : {}),
          ...(result.suggestion !== undefined ? { suggestion: result.suggestion } : {}),
        },
        400,
      );
    case "failed":
      return json({ error: result.detail }, 502);
  }
}

async function handleApi(
  pathname: string,
  request: Request,
  bridge: Bridge,
  agents: AgentAdmin,
): Promise<Response> {
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
      const inviteLimit = body["limit"];
      const parsedInviteLimit =
        inviteLimit === undefined ? undefined : limitSchema.safeParse(inviteLimit);
      if (parsedInviteLimit !== undefined && !parsedInviteLimit.success) {
        return json({ error: parsedInviteLimit.error.issues[0]?.message ?? "invalid limit" }, 400);
      }
      // A refused invite is a 400 with the reason, not a silent no-op: the reason is the
      // whole value of checking a fingerprint, and it is addressed to a person.
      const refused = bridge.invite(toHandle, purpose, parsedInviteLimit?.data);
      if (refused !== undefined) return json(refused, 400);
      return json({ ok: true });
    }

    case "/api/trust-key": {
      const handle = text("handle");
      if (handle.length === 0) return json({ error: "handle is required" }, 400);
      await bridge.trustNewKey(handle);
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
      const openLimit = body["limit"];
      const parsedOpenLimit = openLimit === undefined ? undefined : limitSchema.safeParse(openLimit);
      if (parsedOpenLimit !== undefined && !parsedOpenLimit.success) {
        return json({ error: parsedOpenLimit.error.issues[0]?.message ?? "invalid limit" }, 400);
      }
      bridge.send({
        t: "conversation.open",
        connectionId,
        purpose,
        ...(parsedOpenLimit?.data !== undefined ? { limit: parsedOpenLimit.data } : {}),
      });
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

    case "/api/add": {
      const conversationId = text("conversationId");
      const handle = text("handle");
      if (conversationId.length === 0 || handle.length === 0) {
        return json({ error: "a conversation and a handle are both required" }, 400);
      }
      bridge.send({ t: "conversation.add", conversationId, handle });
      return json({ ok: true });
    }

    case "/api/leave": {
      const conversationId = text("conversationId");
      if (conversationId.length === 0) return json({ error: "conversationId is required" }, 400);
      bridge.send({ t: "conversation.leave", conversationId });
      return json({ ok: true });
    }

    case "/api/delete": {
      const conversationId = text("conversationId");
      const scope = text("scope");
      if (conversationId.length === 0 || (scope !== "me" && scope !== "everyone")) {
        return json({ error: 'a conversation and a scope ("me" or "everyone") are both required' }, 400);
      }
      bridge.send({ t: "conversation.delete", conversationId, scope });
      return json({ ok: true });
    }

    case "/api/reopen": {
      const conversationId = text("conversationId");
      if (conversationId.length === 0) return json({ error: "conversationId is required" }, 400);
      bridge.send({ t: "conversation.reopen", conversationId });
      return json({ ok: true });
    }

    case "/api/history": {
      const conversationId = text("conversationId");
      if (conversationId.length === 0) return json({ error: "conversationId is required" }, 400);
      bridge.requestHistory(conversationId);
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
      const response = text("response");
      await bridge.resolveApproval(
        conversationId,
        runId,
        approved,
        note.length > 0 ? note : undefined,
        response.length > 0 ? response : undefined,
      );
      return json({ ok: true });
    }

    case "/api/directory": {
      bridge.send({ t: "directory.list" });
      return json({ ok: true });
    }

    case "/api/watch": {
      const conversationId = text("conversationId");
      bridge.send({
        t: "watch",
        ...(conversationId.length > 0 ? { conversationId } : {}),
      });
      return json({ ok: true });
    }

    // Managing this machine's jazz agents.
    //
    // The browser never holds the daemon's address or token: it posts here, this process
    // asks jazz, and the roster arrives in the next state snapshot. That token wakes an
    // agent with filesystem access, and the page reading this is one bookmark away from
    // being open on a machine somebody else is sitting at.

    case "/api/conversation/respond": {
      const conversationId = text("conversationId");
      if (conversationId.length === 0) {
        return json({ error: "conversationId is required" }, 400);
      }
      bridge.send({
        t: "conversation.respond",
        conversationId,
        accept: body["accept"] === true,
      });
      return json({ ok: true });
    }

    case "/api/agents/refresh": {
      await agents.refresh();
      return json({ ok: true });
    }

    case "/api/agents/select": {
      const agentId = text("agentId");
      if (agentId.length === 0) return json({ error: "agentId is required" }, 400);
      return fromJazz(await agents.select(agentId));
    }

    case "/api/agents/create": {
      const name = text("name");
      if (name.length === 0) return json({ error: "a name is required", field: "name" }, 400);
      const description = text("description");
      // jazz owns what a valid config is, so the config goes over untouched rather than
      // being screened here — a second copy of those rules would only drift from the first.
      return fromJazz(
        await agents.create({
          name,
          ...(description.length > 0 ? { description } : {}),
          config: (body["config"] ?? {}) as Record<string, unknown>,
        }),
      );
    }

    case "/api/agents/update": {
      const id = text("id");
      if (id.length === 0) return json({ error: "id is required" }, 400);
      const name = text("name");
      const description = text("description");
      const config = body["config"];
      return fromJazz(
        await agents.update(id, {
          ...(name.length > 0 ? { name } : {}),
          // Sent even when blank: clearing a description is a thing somebody may want, and
          // jazz decides whether an empty one is allowed.
          ...(typeof body["description"] === "string" ? { description } : {}),
          ...(config !== undefined ? { config: config as Record<string, unknown> } : {}),
        }),
      );
    }

    case "/api/agents/delete": {
      const id = text("id");
      if (id.length === 0) return json({ error: "id is required" }, 400);
      return fromJazz(await agents.remove(id));
    }

    case "/api/agents/detail": {
      const id = text("id");
      if (id.length === 0) return json({ error: "id is required" }, 400);
      return fromJazz(await agents.detail(id));
    }

    case "/api/agents/models": {
      const provider = text("provider");
      if (provider.length === 0) {
        return json({ error: "provider is required", field: "provider" }, 400);
      }
      const role = text("role");
      return fromJazz(
        role.length > 0 ? await agents.models(provider, role) : await agents.models(provider),
      );
    }

    case "/api/agents/personas":
      return fromJazz(await agents.personas());

    case "/api/agents/tools":
      return fromJazz(await agents.tools());

    default:
      return json({ error: "not found" }, 404);
  }
}
