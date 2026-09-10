/**
 * Public hub directory.
 *
 * Anyone with a reachable hub URL may POST /announce. The marketing site GETs /hubs.
 * Stale entries (no announce for STALE_MS) are dropped from the list. The directory is open —
 * no shared bearer token. Optional QUARTET_HUB_REGISTRY_TOKEN is ignored for auth (kept only
 * so older deploy env files do not break the process).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Hono } from "hono";

const PORT = Number(process.env["PORT"] ?? process.env["QUARTET_PORT"] ?? 8787);
const HOST = process.env["QUARTET_HOST"] ?? "0.0.0.0";
const DATA = process.env["QUARTET_REGISTRY_DATA"] ?? join(process.env["QUARTET_HOME"] ?? "/data", "hubs.json");
const STALE_MS = Number(process.env["QUARTET_REGISTRY_STALE_MS"] ?? 15 * 60_000);
const MAX_DESCRIPTION = 280;
/** Light abuse hygiene: a few announces per address, then one more every few seconds. */
const ANNOUNCE_BURST = 6;
const ANNOUNCE_REFILL_MS = 10_000;

interface HubRecord {
  url: string;
  name: string;
  description: string;
  nsfw: boolean;
  agents: number;
  online: number;
  seenAt: string;
}

type Store = Record<string, HubRecord>;

async function load(): Promise<Store> {
  try {
    const raw = await readFile(DATA, "utf8");
    const parsed = JSON.parse(raw) as Store;
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function save(store: Store): Promise<void> {
  await mkdir(dirname(DATA), { recursive: true });
  await writeFile(DATA, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 !== null) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/** Origin only — http(s), no path, and not a machine-local address. */
function normalizeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (isLoopbackOrPrivateHost(url.hostname)) return undefined;
    url.hash = "";
    url.search = "";
    let path = url.pathname;
    if (path.endsWith("/")) path = path.slice(0, -1);
    if (path !== "" && path !== "/") return undefined;
    return `${url.origin}`;
  } catch {
    return undefined;
  }
}

function live(store: Store, now = Date.now()): HubRecord[] {
  return Object.values(store)
    .filter((hub) => now - Date.parse(hub.seenAt) <= STALE_MS)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Tiny in-process bucket so a single IP cannot rewrite the directory forever. */
const announceBuckets = new Map<string, { tokens: number; at: number }>();

function takeAnnounceSlot(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const at = Date.now();
  const bucket = announceBuckets.get(key);
  let tokens = ANNOUNCE_BURST;
  if (bucket !== undefined) {
    tokens = Math.min(ANNOUNCE_BURST, bucket.tokens + (at - bucket.at) / ANNOUNCE_REFILL_MS);
  }
  if (tokens < 1) {
    announceBuckets.set(key, { tokens, at });
    return { allowed: false, retryAfterMs: Math.ceil((1 - tokens) * ANNOUNCE_REFILL_MS) };
  }
  announceBuckets.set(key, { tokens: tokens - 1, at });
  return { allowed: true };
}

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/hubs", async (c) => {
  c.header("access-control-allow-origin", "*");
  c.header("access-control-allow-methods", "GET");
  const store = await load();
  return c.json({
    hubs: live(store).map(({ url, name, description, nsfw, agents, online, seenAt }) => ({
      url,
      name,
      description,
      nsfw,
      agents,
      online,
      seenAt,
    })),
  });
});

app.post("/announce", async (c) => {
  const address = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("cf-connecting-ip") || "unknown";
  const verdict = takeAnnounceSlot(address);
  if (!verdict.allowed) {
    const seconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
    return c.json(
      { error: `too many announces — try again in ${String(seconds)}s` },
      429,
      { "retry-after": String(seconds) },
    );
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return c.json({ error: "expected a JSON body" }, 400);

  const url = typeof body["url"] === "string" ? normalizeUrl(body["url"]) : undefined;
  if (url === undefined) {
    return c.json(
      { error: "url must be a public http(s) origin (no localhost, no private addresses, no path)" },
      400,
    );
  }

  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (name.length < 1 || name.length > 64) return c.json({ error: "name is required" }, 400);

  let description = typeof body["description"] === "string" ? body["description"].trim() : "";
  if (description.length < 1) return c.json({ error: "description is required" }, 400);
  if (description.length > MAX_DESCRIPTION) description = description.slice(0, MAX_DESCRIPTION);

  const nsfw = body["nsfw"] === true;
  const agents = typeof body["agents"] === "number" && Number.isFinite(body["agents"]) ? Math.max(0, Math.floor(body["agents"])) : 0;
  const online = typeof body["online"] === "number" && Number.isFinite(body["online"]) ? Math.max(0, Math.floor(body["online"])) : 0;

  const store = await load();
  const record: HubRecord = {
    url,
    name,
    description,
    nsfw,
    agents,
    online,
    seenAt: new Date().toISOString(),
  };
  store[url] = record;
  // Drop very old entries so the file does not grow forever.
  const now = Date.now();
  for (const [key, hub] of Object.entries(store)) {
    if (now - Date.parse(hub.seenAt) > STALE_MS * 4) delete store[key];
  }
  await save(store);
  return c.json({ ok: true, hub: record });
});

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
});

console.log(`quartet registry listening on http://${HOST}:${String(server.port)}`);
console.log(`  data → ${DATA}`);
console.log("  directory is open — POST /announce needs no token");
