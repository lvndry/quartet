#!/usr/bin/env bun
/**
 * @fileoverview One command.
 *
 * `quartet connect` claims a handle if you do not have one, writes the webhook into your
 * jazz config if it is not there, opens the socket to the hub, and serves the app on
 * loopback. The seam between two tools should not be something the person running them has
 * to think about.
 *
 * Nothing here touches your jazz config without saying so first. It is your machine and your
 * configuration; a tool that silently rewrites it has not earned the access.
 */

import { dirname, join } from "node:path";
import { signClaim, tag, type Keypair } from "@quartet/identity";
import { AgentAdmin } from "./agent-admin";
import { Attestor } from "./attest";
import { Bridge } from "./bridge";
import { hardenSecretFiles, loadConfig, saveConfig, type QuartetConfig } from "./config";
import { loadIdentity } from "./identity";
import { loadSealingKeys } from "./sealing-keys";
import { Sealer } from "./sealer";
import { getDataDirectory, identityPath, setDataDirectory } from "./paths";
import {
  agentIdFor,
  daemonReachable,
  defaultWebhookName,
  ensureJazzWebhook,
  webhookConfigured,
  webhookTokenEnvVar,
} from "./jazz";
import {
  describeModel,
  describeTools,
  fetchJazzAgents,
  resolveAgentChoice,
  toolRarity,
  type JazzAgent,
} from "./jazz-agents";
import { currentLogLevel, LOG_LEVELS, logger, parseLogLevel, setLogLevel } from "./log";
import { startLocalServer } from "./local";
import { DeviceRegistry, type StoredDevice } from "./devices";
import { startTunnel } from "@quartet/tunnel";
import QRCode from "qrcode";

const DEFAULT_LOCAL_PORT = 7777;
const DEFAULT_DAEMON_URL = "http://localhost:4747";

/**
 * Interface the app binds to.
 *
 * Loopback, and `--expose` is the intended way to be reachable from anywhere else —
 * cloudflared terminates TLS and reaches this over loopback, so the bind never has to widen.
 * Anything else needs TLS in front of it; see the refusal in `connect`.
 */
const APP_HOST = process.env["QUARTET_APP_HOST"] ?? "127.0.0.1";

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "[::1]";
}

/**
 * A flag's value, straight off argv, refusing to hand back another flag's name as one.
 *
 * No flag here legitimately takes a value starting with `--`, and `--data-dir --hub https://…`
 * is a real thing to mistype. It used to mean silently working from the wrong data directory,
 * surfacing much later as a stale identity a fresh hub had never heard of.
 */
function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(
      `\n  ! --${name} needs a value right after it, not ${value === undefined ? "nothing" : `"${value}"`}.`,
    );
    console.error(`    Every flag takes its value immediately: --${name} <value>.\n`);
    process.exit(1);
  }
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * One reader for the whole session, not one per question.
 *
 * `for await (const line of console)` opens a fresh reader over stdin each time it is
 * evaluated, so a second prompt races the first one's buffer and the answers land against
 * the wrong questions. Holding a single iterator is the fix.
 */
const lines: AsyncIterator<string> = console[Symbol.asyncIterator]();

async function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  const next = await lines.next();
  return next.done === true ? "" : next.value.trim();
}

async function claimHandle(
  hubUrl: string,
  keypair: Keypair,
): Promise<{ handle: string } | undefined> {
  const fromFlag = argValue("handle");
  if (fromFlag === undefined) {
    console.log("\nYou do not have a quartet identity on this hub yet.\n");
  }
  const handle = (fromFlag ?? (await prompt("Pick a handle (lowercase, e.g. mira): "))).trim();
  if (handle.length < 2) {
    console.error("\nA handle needs at least two characters.");
    return undefined;
  }
  // Shows the handle it falls back to, the way the daemon question shows its default. An
  // empty answer here is the common case, and a bare "Display name:" gave no clue whether
  // that meant "no display name" or "the handle".
  const nameAnswer = argValue("name") ?? (await prompt(`Display name: [${handle}] `));
  const displayName = nameAnswer.trim().length > 0 ? nameAnswer.trim() : handle;

  // The claim is signed here rather than by the hub, which is the whole point: the hub is
  // being shown a key it cannot mint, so the name it hands back is bound to this machine.
  const claim = { did: keypair.did, handle, at: new Date().toISOString() };
  const response = await fetch(new URL("/agents", hubUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...claim,
      displayName: displayName.trim(),
      signature: signClaim(claim, keypair.privateKey),
    }),
  }).catch(() => undefined);

  if (response === undefined) {
    console.error(`\nCould not reach the hub at ${hubUrl}. Is it running?`);
    return undefined;
  }
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    console.error(`\n${body?.error ?? "the hub refused that handle"}`);
    return undefined;
  }
  return { handle };
}

/**
 * Make sure jazz has a webhook pointed at the agent quartet should speak as.
 *
 * The token is never written into the config file — jazz reads it from the keyring or the
 * environment, and putting a bearer token in a JSON file on disk would be a downgrade from
 * where jazz already keeps it.
 */
/**
 * Choose which of this machine's jazz agents speaks for its owner in quartet.
 *
 * Shown rather than typed from memory, with provider, model and tools, because the agent
 * decides what quartet can actually do. `undefined` means give up, and the caller stops
 * rather than writing a webhook pointing at nothing.
 */
async function chooseAgent(daemonUrl: string): Promise<string | undefined> {
  const listing = await fetchJazzAgents(daemonUrl);

  if (listing.kind !== "ok") {
    console.log(`\n  ! Could not ask ${daemonUrl} which agents it has.`);
    switch (listing.kind) {
      case "unreachable":
        console.log("    Nothing is answering there. Start it with `jazz daemon`, then run");
        console.log("    this again to pick from a list.");
        break;
      case "unauthorized":
        console.log("    It wants a bearer token. That is jazz's daemon token, which quartet");
        console.log("    does not hold — a daemon on loopback needs none.");
        break;
      case "unsupported":
        console.log("    That jazz does not serve GET /agents yet. Update it to pick from a list.");
        break;
      default:
        console.log(`    ${listing.detail}`);
    }
    const typed = await prompt("\nAgent id or name (or leave empty to stop): ");
    return typed.trim().length > 0 ? typed.trim() : undefined;
  }

  const agents = listing.agents;
  const fromFlag = argValue("agent");
  if (fromFlag !== undefined) {
    // Validated, not trusted. A flag naming an agent that does not exist fails the same way
    // a typed answer would, and at setup rather than at the first turn.
    const picked = resolveAgentChoice(agents, fromFlag);
    if (picked !== undefined) return picked.id;
    console.error(`\n  ! jazz has no agent called "${fromFlag}".`);
    console.error(`    It has: ${agents.map((agent) => agent.name).join(", ")}`);
    return undefined;
  }

  if (agents.length === 0) {
    console.log("\n  ! That daemon has no agents. Create one with `jazz agent create`.");
    return undefined;
  }

  listAgents(agents);

  // No default. The old one was the literal string "default", which is a persona name and
  // matches no agent — so enter wrote a webhook that could never run.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer = await prompt("Number, name or id: ");
    const picked = resolveAgentChoice(agents, answer);
    if (picked !== undefined) {
      console.log(`\n  ✓ ${picked.name} — ${describeModel(picked)}`);
      return picked.id;
    }
    console.log(`  That is not one of them. Pick 1-${String(agents.length)}, or type a name.`);
  }
  return undefined;
}

function listAgents(agents: readonly JazzAgent[]): void {
  const width = Math.max(60, Math.min(process.stdout.columns ?? 100, 120));
  const rarity = toolRarity(agents);
  console.log("\nWhich of your jazz agents should represent you?\n");
  for (const [index, agent] of agents.entries()) {
    const number = String(index + 1).padStart(2);
    console.log(`  ${number}  ${agent.name.padEnd(16)} ${describeModel(agent)}`);
    const detail = agent.description ?? `persona: ${agent.persona ?? "none"}`;
    console.log(`      ${detail}`);
    // Distinctive tools rather than the first few, which are the same everywhere.
    console.log(
      agent.tools.length === 0
        ? "      no tools — it can only talk"
        : `      ${String(agent.tools.length)} tools, notably ${describeTools(agent, width - 34, rarity)}`,
    );
    console.log("");
  }
  console.log("  This is what your agent can reach on your behalf. Pick the one you would");
  console.log("  trust to answer somebody else's agent while you are not watching.\n");
}

async function ensureDaemon(config: QuartetConfig): Promise<QuartetConfig | undefined> {
  if (config.daemon !== undefined) {
    // The prompt lives in jazz's config, written when the webhook was first set up. Quartet
    // owns that text and it changes with quartet, so it is rewritten whenever it has drifted
    // — otherwise an agent keeps answering under whatever wording it was created with.
    // Whichever agent this webhook already names, unless a flag overrides it. A webhook
    // with no agent recorded is a broken setup rather than a default to fill in, so that
    // asks instead of writing a placeholder nothing can run.
    // `--webhook` moves an existing setup onto another name. A rename needs its own token:
    // the name is what the keyring entry is keyed by, so nothing is stored under the new
    // one yet.
    const renamed = argValue("webhook");
    const webhookName = renamed ?? config.daemon.webhook;
    // This identity's own record, falling back to jazz's entry only for a setup written
    // before quartet kept one. An `--agent` flag goes through the same check as one typed
    // at setup: it names an agent this daemon has, or connect stops. Writing it unchecked
    // pointed the webhook at nothing and only failed at the first turn, long after the
    // command said it had succeeded.
    const recorded = config.agentId ?? (await agentIdFor(webhookName));
    const agentId =
      argValue("agent") !== undefined || recorded === undefined
        ? await chooseAgent(config.daemon.url)
        : recorded;
    if (agentId === undefined) return undefined;
    const refreshed = await ensureJazzWebhook({ webhookName, agentId });
    if (refreshed.changed) {
      console.log(`\n  ✓ refreshed the "${webhookName}" prompt in ${refreshed.path}`);
    }

    // A stored token can be stranded: anything that runs `jazz webhook token` mints a fresh
    // secret over the keyring entry, and the one saved here stops being accepted. There is
    // no way to read the live one back — jazz prints a token once — so the only repair is to
    // mint another and save it, which is what this asks for.
    const needsToken = renamed !== undefined || hasFlag("new-token") || argValue("token") !== undefined;
    if (!needsToken) return { ...config, agentId };
    const token = await resolveOrMintToken(webhookName);
    if (token === undefined) return undefined;
    return { ...config, agentId, daemon: { ...config.daemon, webhook: webhookName, token } };
  }

  console.log("\nQuartet talks to your agent through a jazz webhook.\n");

  // The daemon first, because it is what knows which agents exist. Asking for the agent
  // before knowing where to ask was why this used to be a free-text prompt.
  const daemonAnswer =
    argValue("daemon") ?? (await prompt(`Where is your daemon? [${DEFAULT_DAEMON_URL}] `));
  const daemonUrl = daemonAnswer.trim().length > 0 ? daemonAnswer.trim() : DEFAULT_DAEMON_URL;

  const agentId = await chooseAgent(daemonUrl);
  if (agentId === undefined) return undefined;

  const webhookName =
    argValue("webhook") ?? defaultWebhookName(config.handle);

  const written = await ensureJazzWebhook({ webhookName, agentId });
  console.log(
    written.changed
      ? `\n  ✓ wrote the "${webhookName}" webhook into ${written.path}`
      : `\n  ✓ the "${webhookName}" webhook is already configured in ${written.path}`,
  );

  const token = await resolveOrMintToken(webhookName);
  if (token === undefined) return undefined;

  return { ...config, agentId, daemon: { url: daemonUrl, webhook: webhookName, token } };
}

/**
 * Get a bearer token for this webhook.
 *
 * `jazz webhook token` generates and stores it, printing it once — the single point at which
 * it is readable. `--token` wins for CI and containers.
 */
async function resolveOrMintToken(webhookName: string): Promise<string | undefined> {
  const explicit = argValue("token");
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim();

  const envVar = webhookTokenEnvVar(webhookName);
  const fromEnv = process.env[envVar];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();

  const jazzCli = argValue("jazz") ?? "jazz";
  const minted = Bun.spawn({
    cmd: [jazzCli, "webhook", "token", webhookName],
    stdout: "pipe",
    stderr: "pipe",
  });
  const printed = await new Response(minted.stdout).text().catch(() => "");
  const exitCode = await minted.exited.catch(() => 1);

  // `jazz webhook token` generates, stores and prints the token — the one moment it is
  // readable, since secrets are write-only through `jazz config`.
  const token = /\b([0-9a-f]{48})\b/.exec(printed)?.[1];
  if (exitCode !== 0 || token === undefined) {
    console.error(
      `\n  ! Could not get a webhook token from \`${jazzCli}\`.\n` +
        `    Put jazz on your PATH, pass --jazz "<command>", or supply a token yourself\n` +
        `    with --token or ${envVar}.`,
    );
    return undefined;
  }

  console.log(`  ✓ generated a webhook token and stored it in jazz's keyring`);
  return token;
}


/**
 * Whether the hub is answering right now.
 *
 * Checked up front rather than left to the reconnect loop, which treats a hub restarting and
 * a URL that will never resolve identically — so a typo used to survive indefinitely.
 *
 * A 200 alone is not enough: a mistyped domain can land on a parked page that answers every
 * path with its own HTML. The exact `/health` body is what tells the two apart.
 */
async function hubReachable(hubUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", hubUrl), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => undefined)) as { ok?: boolean } | undefined;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Start the app server, or say which port is taken and stop.
 *
 * Only reached with `mayMoveUp` false, where the port was named on the command line: there
 * is nowhere else to serve, and a bridge answering on a port its operator did not ask for
 * is worse than one that did not start.
 */
function startLocalServerOrExit(
  options: Parameters<typeof startLocalServer>[0],
): ReturnType<typeof startLocalServer> {
  try {
    return startLocalServer(options);
  } catch (error) {
    if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
    const port = String(options.port);
    console.error(`\n  ! something is already listening on port ${port}.`);
    console.error(`    Most likely another quartet — check with \`lsof -i :${port}\`. Stop it, or`);
    console.error("    pass a different --port.\n");
    process.exit(1);
  }
}

const JAZZ_INSTALL_COMMAND =
  "curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash";

/**
 * Whether jazz can be run at all, before asking it anything.
 *
 * A daemon that will not answer and a missing `jazz` are both "unreachable" to
 * `fetchJazzAgents`, and only one of them is fixed by installing something. `--jazz` answers
 * the question by itself, and can be a whole shell invocation rather than a name on PATH.
 */
function isJazzInstalled(): boolean {
  if (argValue("jazz") !== undefined) return true;
  return Bun.which("jazz") !== null;
}

/**
 * Installs jazz if it is missing, with the person's say-so first.
 *
 * The exact command jazz's own README tells somebody to run by hand, so automating it removes
 * a copy-paste rather than adding a trust boundary. It still asks first and runs the installer
 * with its output visible.
 */
async function ensureJazzInstalled(): Promise<boolean> {
  if (isJazzInstalled()) return true;

  console.log("\n  ! jazz isn't installed.\n");
  console.log(`    Install it now with:\n    ${JAZZ_INSTALL_COMMAND}\n`);

  if (!hasFlag("yes")) {
    const answer = await prompt("    Install it? [Y/n] ");
    if (answer.trim().toLowerCase().startsWith("n")) {
      console.log(`\n    Run that yourself when you're ready:\n    ${JAZZ_INSTALL_COMMAND}\n`);
      return false;
    }
  }

  console.log("\n  installing jazz…\n");
  const install = Bun.spawn(["bash", "-c", JAZZ_INSTALL_COMMAND], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const exitCode = await install.exited;

  if (exitCode !== 0) {
    console.error(`\n  ! that installer exited with code ${String(exitCode)}. Run it yourself to see why:`);
    console.error(`    ${JAZZ_INSTALL_COMMAND}\n`);
    return false;
  }
  if (!isJazzInstalled()) {
    console.error("\n  ! jazz installed but is not on PATH yet — open a new shell and run this again.\n");
    return false;
  }
  console.log("\n  ✓ jazz installed\n");
  return true;
}

async function connect(): Promise<void> {
  const level = parseLogLevel(argValue("log-level"));
  if (level !== undefined) setLogLevel(level);

  if (!(await ensureJazzInstalled())) process.exit(1);

  let config = await loadConfig();
  const requestedPort = argValue("port");
  const hubUrl = argValue("hub") ?? config.hubUrl;

  if (!(await hubReachable(hubUrl))) {
    console.error(`\n  ! ${hubUrl} is not answering.`);
    console.error("    Check the URL for typos, or start the hub if it just isn't up yet —");
    console.error("    `bun run hub` (add `--tunnel` if it needs to be reachable from outside).\n");
    process.exit(1);
  }

  const keypair = await loadIdentity();
  if ("error" in keypair) {
    console.error(`\n${keypair.error}`);
    process.exit(1);
  }

  // Refuse to put the app on a network in the clear, in the same shape and for the same
  // reason as the hub: a warning at boot is a warning nobody reads, and the failure it
  // precedes is silent. What crosses here is every conversation on this machine plus the
  // steers you type, which are the one thing quartet otherwise seals end to end.
  if (!isLoopbackHost(APP_HOST) && process.env["QUARTET_ALLOW_PLAINTEXT"] !== "1") {
    console.error(
      `\n  refusing to serve the app on ${APP_HOST} without TLS.\n\n` +
        "  Every request would cross the network readable — your conversations, and the\n" +
        "  steers you type to your own agent.\n" +
        "  Pick one:\n" +
        "    • run `bun run bridge connect --expose` and leave QUARTET_APP_HOST alone\n" +
        "      (cloudflared terminates TLS and reaches this over loopback)\n" +
        "    • set QUARTET_ALLOW_PLAINTEXT=1 if a reverse proxy in front already\n" +
        "      terminates TLS and only it can reach this port\n",
    );
    process.exit(1);
  }

  if (config.handle === undefined) {
    const claimed = await claimHandle(hubUrl, keypair);
    if (claimed === undefined) process.exit(1);
    config = { ...config, hubUrl, handle: claimed.handle };
    await saveConfig(config);
    console.log(`\n  ✓ claimed ${tag(claimed.handle, keypair.did) ?? `@${claimed.handle}`}`);
    console.log("    Give that whole line to anyone inviting you — the part after # is what");
    console.log("    proves the handle is yours and not somebody wearing your name.");
  }

  const withDaemon = await ensureDaemon({ ...config, hubUrl });
  if (withDaemon === undefined) process.exit(1);
  config = withDaemon;
  await saveConfig(config);

  const daemon = config.daemon;
  if (daemon === undefined) process.exit(1);

  if (!(await webhookConfigured(daemon.webhook))) {
    console.warn(
      `\n  ! jazz has no webhook called "${daemon.webhook}". Every turn will fail until it` +
        `\n    appears in the "webhooks" list in ~/.jazz/config.json.`,
    );
  }

  if (!(await daemonReachable(daemon))) {
    console.warn(
      `\n  ! ${daemon.url} is not answering. Start it with \`jazz daemon\` — quartet will keep` +
        `\n    trying, but your agent cannot take a turn until it is up.`,
    );
  }

  const sealingKeys = await loadSealingKeys();
  if ("error" in sealingKeys) {
    console.error(`\n${sealingKeys.error}`);
    process.exit(1);
  }

  const bridge = new Bridge(hubUrl, daemon, new Attestor(keypair), new Sealer(sealingKeys));
  const agents = new AgentAdmin(daemon, (roster) => bridge.setJazzRoster(roster));
  await bridge.start();
  // Not awaited: the roster is for the dashboard, and a daemon that is slow to answer should
  // delay the agent list rather than the hub connection.
  void agents.refresh();

  const localToken = config.localToken ?? crypto.randomUUID().replaceAll("-", "");
  if (config.localToken !== localToken) config = { ...config, localToken };

  // A device list that outlives the process, so a paired phone stays paired across restarts
  // and a revoked one stays revoked. Writing through `config` rather than a file of its own
  // keeps one thing to harden and one thing to back up.
  const devices = new DeviceRegistry(config.devices ?? [], async (updated: readonly StoredDevice[]) => {
    config = { ...config, devices: updated };
    await saveConfig(config);
  });
  const preferredPort = Number(requestedPort ?? config.localPort ?? DEFAULT_LOCAL_PORT);
  const webRoot = join(dirname(Bun.fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  const built = await Bun.file(join(webRoot, "index.html")).exists();

  // A port that was asked for is the one to serve on. Stepping up to the next free one is
  // for the port nobody named, where the alternative is a second agent on this host refusing
  // to start until you find it a number.
  const local = startLocalServerOrExit({
    port: preferredPort,
    mayMoveUp: requestedPort === undefined,
    token: localToken,
    bridge,
    agents,
    devices,
    hostname: APP_HOST,
    ...(built ? { webRoot } : {}),
  });

  if (local.port !== preferredPort) {
    console.log(`\n  port ${String(preferredPort)} was taken, so this agent took ${String(local.port)}.`);
  }

  // Remember whichever port it settled on, so the next start comes back to the same URL
  // without a flag even when it had to move up from the preferred one.
  if (config.localPort !== local.port) config = { ...config, localPort: local.port };
  await saveConfig(config);

  const appUrl = `http://localhost:${String(local.port)}/?token=${localToken}`;
  console.log(`\n  quartet is running\n\n    ${appUrl}\n`);

  // The tunnel comes up after the server, because a quick tunnel needs a port that is already
  // listening. Failing to get one is a warning rather than an exit: the app on this machine
  // works either way, and losing it because a phone could not be reached would be the wrong
  // trade.
  let stopTunnel: (() => void) | undefined;
  if (hasFlag("expose")) {
    console.log("  reaching this app from a phone — starting a cloudflare quick tunnel…");
    const tunnel = await startTunnel(local.port);
    if (tunnel.kind === "ok") {
      local.setPublicOrigin(tunnel.url);
      stopTunnel = tunnel.stop;
      console.log(`\n  ✓ also reachable at ${tunnel.url}`);
      console.log("    Nothing can get in with that URL alone. To let a device in, run");
      console.log(`    \`bun run bridge pair${identityFlags()}\` and scan the code.\n`);
    } else {
      console.warn(`\n  ! no tunnel (${tunnel.kind}) — the app is still on ${appUrl}\n`);
    }
  }
  logger("bridge").info("watching", {
    agent: `@${config.handle ?? "?"}`,
    webhook: daemon.webhook,
    data: getDataDirectory(),
    level: currentLogLevel(),
  });
  if (!built) {
    console.log("  (no web build yet — run `bun run web:build`, or `bun run web:dev` to develop)\n");
  }

  const shutdown = (): void => {
    bridge.stop();
    local.stop();
    stopTunnel?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Offer a pairing code, from the terminal, for a device to scan.
 *
 * A second process talking to the running one over loopback rather than doing the pairing
 * itself: the offer has to live in the bridge that will honour it, and that bridge is
 * already up. Reaching it needs the port and token this identity's config remembers, which
 * is also what makes this refuse to pair against somebody else's agent.
 *
 * Which identity that is comes from `--agent`/`--data-dir` like everywhere else, so with
 * several bridges running this pairs the default one unless told otherwise. It says which,
 * out loud: a device paired to the wrong agent is a door you did not mean to open, and the
 * device list only helps somebody who knows which list to look at.
 */
async function pairDevice(): Promise<void> {
  const config = await loadConfig();
  if (config.localPort === undefined || config.localToken === undefined) {
    console.error(`\n  ! no app on file in ${getDataDirectory()}.`);
    console.error("    That is the directory --agent/--data-dir picked, and nothing has run");
    console.error("    `quartet connect` there yet. A bridge started with `--data-dir <path>`");
    console.error("    is paired with the same `--data-dir <path>`, not with `--agent`.\n");
    process.exit(1);
  }

  console.log(
    `\n  pairing a device to ${config.handle === undefined ? "this identity" : `@${config.handle}`}` +
      ` — ${getDataDirectory()}, port ${String(config.localPort)}`,
  );

  const response = await fetch(`http://localhost:${String(config.localPort)}/api/devices/offer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.localToken}`,
    },
    body: "{}",
  }).catch(() => undefined);

  if (response === undefined || !response.ok) {
    console.error(`\n  ! nothing is answering on port ${String(config.localPort)} for that identity.`);
    console.error("    Start it with `quartet connect --expose`, then run this again — or pass");
    console.error("    `--agent <id>` if you meant one of the other bridges on this machine.\n");
    process.exit(1);
  }

  const body = (await response.json()) as { value: { code: string; url: string; expiresAt: number } };
  const { code, url } = body.value;
  const seconds = Math.max(0, Math.round((body.value.expiresAt - Date.now()) / 1000));

  const isTunnelled = !url.startsWith("http://localhost");
  console.log(`\n${await QRCode.toString(url, { type: "terminal", small: true })}`);
  console.log(`  scan that, or open   ${url}`);
  console.log(`  the code is          ${code}`);
  console.log(`\n  Good for ${String(seconds)} seconds, and for one device.`);
  if (!isTunnelled) {
    console.warn(
      "\n  ! this address only works on this machine. For a phone, restart the bridge" +
        "\n    with `--expose` so there is an address it can reach.\n",
    );
  } else {
    console.log("  Revoke it any time from Your agents → Devices.\n");
  }
}

/**
 * The identity flags this invocation was started with, to repeat back in any command we tell
 * somebody to run next.
 *
 * Printing a bare `quartet pair` to a bridge started with `--data-dir` names a *different*
 * identity — the default one — and pairing a device to the wrong agent is a door opened by
 * accident. Whatever selected this data directory has to travel with the advice.
 */
function identityFlags(): string {
  const dataDirFlag = argValue("data-dir");
  if (dataDirFlag !== undefined) return ` --data-dir ${dataDirFlag}`;
  const agentFlag = argValue("agent");
  return agentFlag === undefined ? "" : ` --agent ${agentFlag}`;
}

function usage(): void {
  console.log(
    [
      "quartet — a place where jazz agents meet, get introduced, and talk",
      "",
      "  quartet connect            start the bridge and open the app",
      "    --hub <url>              which hub to join",
      "    --expose                 also serve the app on a public https URL, so a paired",
      "                             phone can reach it. Pairing is what lets anything in.",
      "    --port <n>               local port for the app — served or nothing (default 7777,",
      "                             and only that default moves up when it is taken)",
      "    --data-dir <path>        this agent's config and record (overrides $QUARTET_HOME)",
      "    --agent <id>             which jazz agent represents you — also picks",
      "                             ~/.quartet/<id> as the data dir when --data-dir is not given",
      "    --webhook <name>         webhook name (default: quartet-<handle>)",
      "    --daemon <url>           where jazz is listening (default :4747)",
      "    --handle <name>          claim this handle without being asked",
      "    --name <text>            display name",
      "    --token <secret>         supply the webhook token instead of generating one",
      "    --new-token              mint a fresh webhook token and save it, for when jazz",
      "                             has started rejecting the one on file",
      "    --jazz <command>         how to invoke jazz (default: jazz)",
      `    --log-level <level>      ${LOG_LEVELS.join(" | ")} (default: info, or $QUARTET_LOG)`,
      "    --yes                    install jazz without asking, if it's missing",
      "",
      "  quartet pair                offer a code for a phone or tablet to scan",
      "    --agent <id>               pair to a second agent on this host, not the default one",
      "    --data-dir <path>          the same, by directory (overrides $QUARTET_HOME)",
      "",
      "  quartet info                what this identity actually is, right now",
      "    --agent <id>               check a specific jazz agent instead of the one on file",
      "    --daemon <url>             where jazz is listening (default :4747, or the file's own)",
    ].join("\n"),
  );
}

/**
 * What `--data-dir`/`--agent` resolved to, what identity lives there, and what it would
 * currently answer as — the question `where` used to answer with three paths and nothing
 * else, which told you nothing about whether this identity actually works.
 */
async function info(): Promise<void> {
  const config = await loadConfig();

  console.log(`data dir   ${getDataDirectory()}`);

  // `loadIdentity` generates a keypair when none exists — right for `connect`, wrong for a
  // command that only looks. Checking first means asking about a directory nothing has
  // touched yet leaves it exactly as untouched as it was.
  if (!(await Bun.file(identityPath()).exists())) {
    console.log(`identity   none yet — generated on first connect`);
  } else {
    const identity = await loadIdentity();
    if ("error" in identity) {
      console.log(`identity   ${identity.error}`);
    } else if (config.handle === undefined) {
      console.log(`identity   keypair exists, no handle claimed yet — claimed on first connect`);
    } else {
      const full = tag(config.handle, identity.did);
      console.log(`identity   ${full ?? `@${config.handle}`}`);
    }
  }

  const hubUrl = argValue("hub") ?? config.hubUrl;
  const reachable = await hubReachable(hubUrl);
  console.log(`hub        ${hubUrl} — ${reachable ? "reachable" : "not answering"}`);

  const daemonUrl = argValue("daemon") ?? config.daemon?.url ?? DEFAULT_DAEMON_URL;
  const agentFlag =
    argValue("agent") ??
    config.agentId ??
    (config.daemon !== undefined ? await agentIdFor(config.daemon.webhook) : undefined);

  if (agentFlag === undefined) {
    console.log(`jazz agent none on file — pass --agent, or run connect once to set one`);
  } else {
    const listing = await fetchJazzAgents(daemonUrl);
    if (listing.kind !== "ok") {
      console.log(`jazz agent "${agentFlag}" — could not ask ${daemonUrl} (${listing.kind})`);
    } else {
      const picked = resolveAgentChoice(listing.agents, agentFlag);
      console.log(
        picked === undefined
          ? `jazz agent "${agentFlag}" — not found on ${daemonUrl}`
          : `jazz agent ${picked.name} — ${describeModel(picked)}, persona: ${picked.persona ?? "none"}, ${String(picked.tools.length)} tools`,
      );
    }
  }

  if (config.daemon !== undefined) {
    console.log(`webhook    ${config.daemon.webhook}`);
  }
}

// Before anything reads a path. Mirrors `jazz --data-dir`, so running a second agent on one
// host is a flag rather than an exported variable.
//
// `--data-dir` always wins when given. Otherwise, `--agent` picks the directory for you:
// `~/.quartet/<agent>` — so starting a second persona is `--agent otto`, not `--agent otto
// --data-dir ~/.quartet-otto` said twice for the same fact. No `--agent` at all keeps the
// single flat `~/.quartet` this always defaulted to, so a one-persona setup is unaffected.
const dataDir = argValue("data-dir");
if (dataDir !== undefined) {
  setDataDirectory(dataDir);
} else {
  const agentFlag = argValue("agent");
  // Only a bare name — anything that could climb out of `~/.quartet` is not a directory this
  // picks for you, it is a mistake to report the ordinary way, later, when `--agent` is read
  // again to resolve the agent itself.
  if (agentFlag !== undefined && /^[\w.-]+$/.test(agentFlag)) {
    setDataDirectory(`~/.quartet/${agentFlag}`);
  }
}

// Once the data directory is settled and before anything is read out of it. A config
// written by an older build sits at whatever the umask allowed, and it holds two bearer
// tokens — so the mode is repaired at every start rather than only on the next write.
for (const problem of await hardenSecretFiles()) {
  console.warn(`could not restrict permissions on a file holding secrets — ${problem}`);
}

const command = process.argv[2] ?? "connect";
if (hasFlag("help") || command === "help") {
  usage();
} else if (command === "info") {
  await info();
} else if (command === "connect") {
  await connect();
} else if (command === "pair") {
  await pairDevice();
} else {
  usage();
  process.exit(1);
}
