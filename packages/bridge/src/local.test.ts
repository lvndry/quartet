/**
 * The door, rather than what is behind it: which callers the app answers, and which it does
 * not. Pairing moved the app from "you had to be at this machine" to "you have to hold a
 * credential", so these are the assertions that carry that weight.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeviceRegistry } from "./devices";
import { startLocalServer } from "./local";
import type { AgentAdmin } from "./agent-admin";
import type { Bridge } from "./bridge";

const TOKEN = "a".repeat(32);

const stubBridge = {
  subscribe: () => () => {},
  snapshot: () => ({}),
  setLocalOrigin: () => {},
  onDaemonProgress: () => false,
} as unknown as Bridge;

const stubAgents = { refresh: async () => {} } as unknown as AgentAdmin;

let server: ReturnType<typeof startLocalServer>;
let devices: DeviceRegistry;
let origin: string;

beforeEach(() => {
  devices = new DeviceRegistry([], async () => {});
  server = startLocalServer({
    port: 0,
    mayMoveUp: true,
    token: TOKEN,
    bridge: stubBridge,
    agents: stubAgents,
    devices,
  });
  origin = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(() => {
  server.stop();
});

/** The one API route that reads nothing and changes nothing, so it isolates the auth check. */
function ask(headers: Record<string, string>): Promise<Response> {
  return fetch(`${origin}/api/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

describe("the local token", () => {
  test("opens the door on loopback", async () => {
    expect((await ask({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  test("is refused when the request did not arrive on loopback", async () => {
    // What a request through the tunnel looks like: cloudflared forwards the browser's Host.
    const response = await ask({
      authorization: `Bearer ${TOKEN}`,
      host: "something.trycloudflare.com",
    });
    expect(response.status).toBe(401);
  });

  test("a wrong token is nobody", async () => {
    expect((await ask({ authorization: "Bearer wrong" })).status).toBe(401);
  });

  test("no credential at all is nobody", async () => {
    expect((await ask({})).status).toBe(401);
  });
});

describe("cross-origin requests", () => {
  test("are refused even holding the right token", async () => {
    const response = await ask({
      authorization: `Bearer ${TOKEN}`,
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
  });

  test("from the page we served are fine", async () => {
    const response = await ask({ authorization: `Bearer ${TOKEN}`, origin });
    expect(response.status).toBe(200);
  });

  test("from the tunnel are fine once it is known", async () => {
    server.setPublicOrigin("https://paired.trycloudflare.com");
    const response = await ask({
      authorization: `Bearer ${TOKEN}`,
      origin: "https://paired.trycloudflare.com",
    });
    expect(response.status).toBe(200);
  });
});

describe("pairing", () => {
  async function pair(code: string): Promise<Response> {
    return fetch(`${origin}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "a phone" }),
    });
  }

  test("hands the token back in a cookie and never in the body", async () => {
    const offer = devices.offerPairing();
    const response = await pair(offer.code);
    expect(response.status).toBe(200);

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("quartet_device=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");

    const body = (await response.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(setCookie.split("=")[1]?.split(";")[0] ?? "?");
  });

  test("is refused when nothing is being offered", async () => {
    expect((await pair("ABCDEFGH")).status).toBe(409);
  });

  test("a paired device is then let in from anywhere, by its cookie alone", async () => {
    const offer = devices.offerPairing();
    const paired = await pair(offer.code);
    const cookie = (paired.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const response = await ask({ cookie, host: "something.trycloudflare.com" });
    expect(response.status).toBe(200);
  });

  test("a revoked device is refused on its very next request", async () => {
    const offer = devices.offerPairing();
    const paired = await pair(offer.code);
    const cookie = (paired.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const deviceId = devices.list()[0]?.id ?? "";

    expect((await ask({ cookie })).status).toBe(200);
    await devices.revoke(deviceId);
    expect((await ask({ cookie })).status).toBe(401);
  });
});

describe("the app shell", () => {
  test("serves a scanned pairing link rather than 404ing it", async () => {
    // No web build in test, so the 503 is the "no build" message — the point is that GET
    // /pair is treated as a page, not as the API route that shares its path.
    const response = await fetch(`${origin}/pair?code=ABCDEFGH`);
    expect(response.status).not.toBe(404);
  });
});
