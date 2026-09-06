/**
 * @fileoverview What a compiled `quartet` has to be able to do before it is published.
 *
 * `scripts/smoke.ts` drives the conversation by importing the modules, which proves the logic
 * and proves nothing about the executable: everything that breaks in a binary breaks at the
 * seam between code and the files it expects to find beside it. A path computed from
 * `import.meta.url`, an asset read off disk, a dependency that writes into its own
 * `node_modules` — each of those passes every unit test and then ships an executable that
 * serves a blank page.
 *
 * So this runs the real thing as a process: the hub subcommand, then `connect` against a
 * stand-in daemon, then fetches the app out of the running bridge and checks that the shell,
 * a content-hashed script, a stylesheet and a font all come back with the right type.
 *
 * Run with: bun scripts/binary-smoke.ts [path-to-binary]
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../package.json" with { type: "json" };

const HUB_PORT = 8491;
const DAEMON_PORT = 8492;
const APP_PORT = 8493;

const ROOT = new URL("..", import.meta.url).pathname;
const defaultBinary = join(
  ROOT,
  "deploy",
  "binaries",
  `quartet-${process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`,
);
const BINARY = process.argv[2] ?? defaultBinary;

const cleanups: (() => void | Promise<void>)[] = [];

async function teardown(): Promise<void> {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // Teardown is best-effort; whatever failed first is the thing worth reporting.
    }
  }
}

async function fail(message: string): Promise<never> {
  console.error(`\n  ✗ ${message}\n`);
  await teardown();
  process.exit(1);
}

async function check(condition: boolean, message: string): Promise<void> {
  if (!condition) await fail(message);
  console.log(`  ✓ ${message}`);
}

async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await Bun.sleep(100);
  }
  await fail(`timed out waiting for ${what}`);
}

async function reachable(url: string): Promise<boolean> {
  return await fetch(url)
    .then((response) => response.ok)
    .catch(() => false);
}

/** A stand-in for `jazz daemon`: enough of the door for `connect` to get all the way through. */
function fakeDaemon(port: number): { stop: () => void } {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("{}");
      if (url.pathname === "/agents") {
        return Response.json({ agents: [{ id: "otto", name: "otto", tools: [] }] });
      }
      return Response.json({ ok: true, answer: "hello" });
    },
  });
  return { stop: () => server.stop(true) };
}

if (!(await Bun.file(BINARY).exists())) {
  console.error(`\n  ✗ no binary at ${BINARY} — run \`bun run build:binary\` first.\n`);
  process.exit(1);
}

console.log(`\nSmoke-testing ${BINARY}\n`);

const version = await new Response(
  Bun.spawn([BINARY, "--version"], { stdout: "pipe" }).stdout,
).text();
await check(version.trim() === manifest.version, `--version reports ${manifest.version}`);

const home = await mkdtemp(join(tmpdir(), "quartet-binary-smoke-"));
cleanups.push(() => rm(home, { recursive: true, force: true }));

/**
 * A `jazz` that exists and does nothing.
 *
 * `connect` offers to install jazz when it cannot find one, and an offer read from a closed
 * stdin comes back empty, which is a yes. Without this the smoke run curl-pipes jazz's
 * installer onto whatever machine it is on — which it did, on the first CI run. Nothing here
 * needs the real CLI: the stand-in daemon answers everything `connect` asks over HTTP, and
 * `--token` means no token has to be minted.
 */
// Under `bin/`, not beside it: `JAZZ_HOME` below is `<home>/jazz`, and a file of that name
// is a directory jazz's config cannot be written into.
const fakeJazz = join(home, "bin", "jazz");
await Bun.write(fakeJazz, "#!/bin/sh\nexit 0\n");
await Bun.$`chmod 755 ${fakeJazz}`.quiet();

const daemon = fakeDaemon(DAEMON_PORT);
cleanups.push(() => daemon.stop());

const hub = Bun.spawn([BINARY, "hub"], {
  env: { ...process.env, PORT: String(HUB_PORT), QUARTET_DB: join(home, "hub.sqlite") },
  stdout: "inherit",
  stderr: "inherit",
});
cleanups.push(() => hub.kill());
await waitFor("the hub to listen", () => reachable(`http://127.0.0.1:${String(HUB_PORT)}/join`));

// The theme travels as a text import rather than a file beside the executable, so an empty
// favicon here means the hub half of the binary lost its assets.
const favicon = await fetch(`http://127.0.0.1:${String(HUB_PORT)}/favicon.svg`);
await check(
  favicon.ok && (await favicon.text()).includes("<svg"),
  "the hub serves its favicon from inside the binary",
);

const connect = Bun.spawn(
  [
    BINARY,
    "connect",
    "--hub",
    `http://127.0.0.1:${String(HUB_PORT)}`,
    "--identity",
    "smoke",
    "--handle",
    "smoketest",
    "--name",
    "Smoke",
    "--agent",
    "otto",
    "--daemon",
    `http://127.0.0.1:${String(DAEMON_PORT)}`,
    "--token",
    "test-token",
    "--jazz",
    fakeJazz,
    "--no-expose",
    "--port",
    String(APP_PORT),
  ],
  {
    env: { ...process.env, QUARTET_HOME: join(home, "quartet"), JAZZ_HOME: join(home, "jazz") },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
);
cleanups.push(() => connect.kill());

const app = `http://127.0.0.1:${String(APP_PORT)}`;
await waitFor("the bridge to serve the app", () => reachable(app));

/**
 * The whole point of the exercise. In a checkout the app is a directory the bridge reads; in a
 * binary it is a table of embedded files, and a wrong table is a 503 that reads like a missing
 * build. Content types are asserted because they come from the requested URL rather than the
 * embedded name — a stylesheet delivered as `text/plain` renders unstyled and says nothing.
 */
const shell = await fetch(app);
const html = await shell.text();
await check(shell.status === 200, "the app shell is served from inside the binary");
await check(
  (shell.headers.get("content-type") ?? "").startsWith("text/html"),
  "the shell arrives as text/html",
);

async function fetchAsset(pattern: RegExp, label: string, expectedType: string): Promise<void> {
  const path = pattern.exec(html)?.[0];
  if (path === undefined) await fail(`the shell references no ${label}`);
  const response = await fetch(`${app}${path ?? ""}`);
  await check(
    response.status === 200 && (response.headers.get("content-type") ?? "").startsWith(expectedType),
    `${label} ${path ?? ""} is served as ${expectedType}`,
  );
}

// Content-hashed names, so these only resolve if the table was generated from the build that
// actually shipped rather than from a stale one.
await fetchAsset(/\/assets\/[A-Za-z0-9._-]+\.js/, "the entry script", "text/javascript");
await fetchAsset(/\/assets\/[A-Za-z0-9._-]+\.css/, "the stylesheet", "text/css");

const font = await fetch(`${app}/assets/KaTeX_Main-Regular-B22Nviop.woff2`);
await check(
  font.status === 200 && font.headers.get("content-type") === "font/woff2",
  "a binary asset survives embedding with its own type",
);

const route = await fetch(`${app}/rooms/anything`);
await check(
  route.status === 200 && (await route.text()).includes("<!doctype html>"),
  "an unknown path falls back to the shell so client routing survives a hard refresh",
);

await teardown();
console.log("\n  the binary works.\n");
