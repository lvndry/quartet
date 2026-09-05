/**
 * @fileoverview The app, served from your own machine.
 *
 * Bound to loopback, and guarded by a token printed at startup — the same shape jazz's own
 * daemon uses, and for the same reason: a port on localhost is reachable by every page in
 * your browser, so "it's only local" is not by itself a security property. The `Origin`
 * check is what stops a site you happen to be visiting from driving your agent.
 *
 * A tunnel can put this same server in front of a paired phone without widening the bind —
 * cloudflared reaches it over loopback and terminates TLS in front. What changes then is
 * that being on this machine is no longer the thing that grants access, so there are two
 * credentials here rather than one: the local token, and a paired device's cookie. See
 * `docs/design/paired-devices.md`.
 */

import { limitSchema } from "@quartet/protocol";
import type { AgentAdmin } from "./agent-admin";
import type { Bridge, BridgeState } from "./bridge";
import type { DeviceRegistry, PairedDevice } from "./devices";
import type { JazzResult } from "./jazz-admin";
import type { ServerWebSocket } from "bun";

/** The cookie a paired device presents. Never readable by a script on the page. */
const DEVICE_COOKIE = "quartet_device";

/**
 * How long a device's cookie survives in the browser.
 *
 * Long, because revocation is server-side and immediate — the list in the app is the control
 * that matters, and an expiry short enough to be a security feature would mostly be a
 * re-pairing chore. Four hundred days is the ceiling browsers will honour anyway.
 */
const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

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
  /** Which devices may drive this agent from somewhere other than here. */
  readonly devices: DeviceRegistry;
  /** Directory holding the built web app. Absent in development, where Vite serves it. */
  readonly webRoot?: string;
  /**
   * Interface to bind. Loopback unless somebody deliberately widened it, which `main.ts`
   * refuses to allow without TLS in front — the same refusal the hub makes.
   */
  readonly hostname?: string;
}

interface BrowserSocket {
  authorized: boolean;
  /** Set when a paired device opened this socket, so revoking that device can close it. */
  deviceId: string | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Only pages we served — from loopback, or from our own tunnel when one is running.
 *
 * A missing `Origin` is allowed because non-browser callers (curl, the CLI's own health
 * check) do not send one, and they are not the threat here — a cross-site request always
 * carries one. Widening the bind does not soften this check: it is still the only thing
 * stopping a site you happen to be visiting from driving your agent, and a tunnel means more
 * sites can try.
 */
function originAllowed(request: Request, port: number, publicOrigin: string | undefined): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  if (publicOrigin !== undefined && origin === publicOrigin) return true;
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

/**
 * Whether this request arrived at a loopback address rather than through the tunnel.
 *
 * Read off `Host`, which cloudflared forwards as the browser sent it. This gates the local
 * token, which is a handoff between two processes on one machine and has no business being
 * accepted from the public internet.
 *
 * Defence in depth rather than the gate itself: if some proxy in front did rewrite `Host` to
 * loopback, the local token would still have to be guessed — it is a 128-bit random secret
 * that only ever appears on this machine's terminal. The check removes a class of mistake
 * (a bookmarked URL with `?token=` opened on a phone, then synced), not the last line.
 */
function arrivedOnLoopback(request: Request): boolean {
  const host = request.headers.get("host");
  if (host === null) return true;
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function presentedToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return new URL(request.url).searchParams.get("token") ?? "";
}

function cookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

/**
 * Who is asking: this machine, a paired device, or nobody we know.
 *
 * Two credentials, deliberately not interchangeable. The local token is only honoured on
 * loopback; a paired device's cookie works from anywhere, which is the entire point of
 * pairing it.
 */
type Caller =
  | { readonly kind: "local" }
  | { readonly kind: "device"; readonly device: PairedDevice }
  | { readonly kind: "anonymous" };

function identify(request: Request, options: LocalServerOptions): Caller {
  if (arrivedOnLoopback(request) && presentedToken(request) === options.token) {
    return { kind: "local" };
  }
  const presented = cookie(request, DEVICE_COOKIE);
  if (presented !== undefined) {
    const device = options.devices.verify(presented);
    if (device !== undefined) return { kind: "device", device };
  }
  return { kind: "anonymous" };
}

/**
 * Serve the app, on the first free port at or above the given one when `mayMoveUp` allows.
 *
 * Scanning means a second agent on one host needs no port flag. The `Origin` check reads the
 * bound port rather than the requested one, so a page served from 7778 is still ours.
 */
export function startLocalServer(options: LocalServerOptions): {
  port: number;
  stop: () => void;
  /**
   * Tell the server the public origin it is also reachable on.
   *
   * Set after the fact because a tunnel needs the bound port to exist before it can be
   * pointed at one, so the origin is not known when the server starts.
   */
  setPublicOrigin: (origin: string | undefined) => void;
} {
  const browsers = new Set<ServerWebSocket<BrowserSocket>>();
  let publicOrigin: string | undefined;

  // Revocation has to reach sockets that are already open. Refusing the next request while
  // an existing one keeps streaming the room is not revocation.
  options.devices.onRevokedDevice((deviceId) => {
    for (const socket of browsers) {
      if (socket.data.deviceId === deviceId) socket.close(4003, "device revoked");
    }
  });

  const unsubscribe = options.bridge.subscribe((state: BridgeState) => {
    const payload = JSON.stringify({ t: "state", state });
    for (const socket of browsers) {
      if (socket.data.authorized) socket.send(payload);
    }
  });

  let boundPort = options.port;

  const serve = (port: number) => Bun.serve<BrowserSocket, never>({
    port,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request, bunServer) {
      const url = new URL(request.url);

      if (!originAllowed(request, boundPort, publicOrigin)) {
        return json({ error: "cross-origin requests are not accepted here" }, 403);
      }

      const caller = identify(request, options);

      // The pairing door: the one route that answers to nobody, because a device that could
      // authenticate would not need to pair. What guards it is the code itself — offered only
      // from this machine, single-use, two minutes, and burned after ten wrong guesses.
      //
      // Only the POST. A `GET /pair?code=…` is the scanned QR opening the app, and falls
      // through to the shell like any other client-side route.
      if (url.pathname === "/pair" && request.method === "POST") {
        return pair(request, options);
      }

      if (url.pathname === "/socket") {
        if (caller.kind === "anonymous") {
          return new Response("unauthorized", { status: 401 });
        }
        const deviceId = caller.kind === "device" ? caller.device.id : undefined;
        return bunServer.upgrade(request, { data: { authorized: true, deviceId } })
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
        if (caller.kind === "anonymous") return json({ error: "unauthorized" }, 401);
        if (caller.kind === "device") void options.devices.touch(caller.device.id);
        return handleApi(
          url.pathname,
          request,
          options.bridge,
          options.agents,
          options.devices,
          // A device pairs against whatever address it can actually reach. That is the tunnel
          // when one is up, and loopback otherwise — which still pairs a second browser on
          // this machine, and is the only honest answer when there is no public address.
          () => publicOrigin ?? `http://localhost:${String(boundPort)}`,
        );
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
  // What the OS actually gave us, which is not `options.port` when that was 0 and not the
  // requested one when the scan stepped up. The `Origin` check compares against this, so a
  // stale value here would reject the very page this server just served.
  boundPort = Number(running.port);
  // The daemon is told where to report only once the port is known, because it is whichever
  // one was free rather than the one that was asked for.
  options.bridge.setLocalOrigin(`http://127.0.0.1:${String(running.port)}`);
  return {
    port: Number(running.port),
    stop: () => {
      unsubscribe();
      running.stop(true);
    },
    setPublicOrigin: (origin: string | undefined) => {
      publicOrigin = origin;
    },
  };
}

/**
 * Redeem a pairing code for a device token.
 *
 * The token comes back only in a `Set-Cookie` — never in the body, and never in a URL. A URL
 * is copied, logged by intermediaries, synced across a browser profile, and screenshotted;
 * `HttpOnly` additionally means a script injected into the page cannot read it.
 *
 * `Secure` is unconditional. Pairing happens over the tunnel, which is https, and browsers
 * treat `http://localhost` as trustworthy enough to accept it anyway — so there is no case
 * where dropping it would help and several where keeping it matters.
 */
async function pair(request: Request, options: LocalServerOptions): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return json({ error: "expected a JSON body" }, 400);
  const code = typeof body["code"] === "string" ? body["code"] : "";
  const name = typeof body["name"] === "string" ? body["name"] : "";

  const result = await options.devices.redeem(code, name);
  switch (result.kind) {
    case "ok":
      return new Response(JSON.stringify({ ok: true, device: result.device }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie":
            `${DEVICE_COOKIE}=${encodeURIComponent(result.token)}; Path=/; Max-Age=` +
            `${String(DEVICE_COOKIE_MAX_AGE_SECONDS)}; HttpOnly; Secure; SameSite=Strict`,
        },
      });
    case "no-offer":
      return json({ error: "nothing is pairing right now. Run `quartet pair` on the machine." }, 409);
    case "expired":
      return json({ error: "that code has expired. Run `quartet pair` again for a fresh one." }, 410);
    case "burned":
      return json({ error: "too many wrong codes. Run `quartet pair` again for a fresh one." }, 429);
    case "wrong-code":
      return json(
        { error: `that code is not right — ${String(result.attemptsLeft)} attempts left.` },
        401,
      );
  }
}

/**
 * Turn jazz's answer into the app's.
 *
 * Every failure kind gets its own sentence: a UI that collapses them says "something went
 * wrong" to somebody whose daemon is simply not running. `rejected` carries jazz's `field`
 * and `suggestion` through so a form can mark the input that was wrong.
 *
 * 502 for everything that is jazz's state rather than the caller's mistake.
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
  devices: DeviceRegistry,
  pairingOrigin: () => string,
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
      // A tag, not a handle: the app picks somebody out of a directory it can already see, so
      // it knows which @mira it meant and there is no reason to make the hub guess.
      const tag = text("tag");
      if (conversationId.length === 0 || tag.length === 0) {
        return json({ error: "a conversation and a tag are both required" }, 400);
      }
      bridge.send({ t: "conversation.add", conversationId, tag });
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

    // Paired devices. Reachable by a paired device as well as from this machine, because
    // full parity means the phone can see and revoke the list it is on — including itself,
    // which is the one revocation somebody holding a phone they are about to hand over can
    // actually perform.

    case "/api/devices": {
      const offer = devices.pendingOffer();
      return json({
        ok: true,
        value: {
          devices: devices.list(),
          ...(offer !== undefined ? { pairing: offer } : {}),
        },
      });
    }

    case "/api/devices/offer": {
      const offer = devices.offerPairing();
      // The URL to put in a QR. A pairing code in a URL is fine — it is single-use and
      // expires in two minutes — where a device token in one would not be, which is why the
      // token comes back in a cookie and never here.
      return json({
        ok: true,
        value: { ...offer, url: `${pairingOrigin()}/pair?code=${offer.code}` },
      });
    }

    case "/api/devices/cancel": {
      devices.cancelPairing();
      return json({ ok: true });
    }

    case "/api/devices/revoke": {
      const deviceId = text("deviceId");
      if (deviceId.length === 0) return json({ error: "deviceId is required" }, 400);
      const removed = await devices.revoke(deviceId);
      return removed ? json({ ok: true }) : json({ error: "no such device" }, 404);
    }

    case "/api/agents/personas":
      return fromJazz(await agents.personas());

    case "/api/agents/tools":
      return fromJazz(await agents.tools());

    default:
      return json({ error: "not found" }, 404);
  }
}
