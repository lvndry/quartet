#!/usr/bin/env bun
/**
 * @fileoverview One command.
 *
 * `quartet connect` claims a handle if you do not have one, writes the trigger into your
 * jazz config if it is not there, opens the socket to the hub, and serves the app on
 * loopback. The seam between two tools should not be something the person running them has
 * to think about.
 *
 * Nothing here touches your jazz config without saying so first. It is your machine and your
 * configuration; a tool that silently rewrites it has not earned the access.
 */

import { dirname, join } from "node:path";
import { Bridge } from "./bridge";
import { loadConfig, saveConfig, type QuartetConfig } from "./config";
import { getDataDirectory, setDataDirectory } from "./paths";
import {
  daemonReachable,
  ensureJazzWebhook,
  webhookConfigured,
  webhookTokenEnvVar,
} from "./jazz";
import { currentLogLevel, LOG_LEVELS, logger, parseLogLevel, setLogLevel } from "./log";
import { startLocalServer } from "./local";

const DEFAULT_LOCAL_PORT = 7777;
const DEFAULT_WEBHOOK = "quartet";
const DEFAULT_DAEMON_URL = "http://localhost:4747";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
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

async function claimHandle(hubUrl: string): Promise<{ token: string; handle: string } | undefined> {
  const fromFlag = argValue("handle");
  if (fromFlag === undefined) {
    console.log("\nYou do not have a quartet identity on this hub yet.\n");
  }
  const handle = fromFlag ?? (await prompt("Pick a handle (lowercase, e.g. mira): "));
  if (handle.trim().length < 2) {
    console.error("\nA handle needs at least two characters.");
    return undefined;
  }
  const nameAnswer = argValue("name") ?? (await prompt("Display name: "));
  const displayName = nameAnswer.trim().length > 0 ? nameAnswer.trim() : handle.trim();

  const response = await fetch(new URL("/agents", hubUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: handle.trim(), displayName: displayName.trim() }),
  }).catch(() => undefined);

  if (response === undefined) {
    console.error(`\nCould not reach the hub at ${hubUrl}. Is it running?`);
    return undefined;
  }
  const body = (await response.json().catch(() => null)) as
    | { token?: string; error?: string }
    | null;
  if (!response.ok || body?.token === undefined) {
    console.error(`\n${body?.error ?? "the hub refused that handle"}`);
    return undefined;
  }
  return { token: body.token, handle: handle.trim() };
}

/**
 * Make sure jazz has a trigger pointed at the agent quartet should speak as.
 *
 * The token is never written into the config file — jazz reads it from the keyring or the
 * environment, and putting a bearer token in a JSON file on disk would be a downgrade from
 * where jazz already keeps it.
 */
async function ensureDaemon(config: QuartetConfig): Promise<QuartetConfig | undefined> {
  if (config.daemon !== undefined) return config;

  console.log("\nQuartet talks to your agent through a jazz webhook.\n");
  const agentAnswer =
    argValue("agent") ?? (await prompt("Which jazz agent should represent you? [default] "));
  const agentId = agentAnswer.trim().length > 0 ? agentAnswer.trim() : "default";

  const daemonAnswer =
    argValue("daemon") ?? (await prompt(`Where is your daemon? [${DEFAULT_DAEMON_URL}] `));
  const daemonUrl = daemonAnswer.trim().length > 0 ? daemonAnswer.trim() : DEFAULT_DAEMON_URL;

  // One webhook per agent, not one per machine: two agents sharing a daemon would otherwise
  // point the same webhook at whichever connected last.
  const webhookName = argValue("webhook") ?? argValue("trigger") ?? DEFAULT_WEBHOOK;

  const written = await ensureJazzWebhook({ webhookName, agentId });
  console.log(
    written.changed
      ? `\n  ✓ wrote the "${webhookName}" webhook into ${written.path}`
      : `\n  ✓ the "${webhookName}" webhook is already configured in ${written.path}`,
  );

  const token = await resolveOrMintToken(webhookName);
  if (token === undefined) return undefined;

  // The daemon reads its webhook list once, at startup. The token is resolved per request,
  // so only a newly *added* webhook needs the restart — but saying nothing here means the
  // first conversation silently 404s and there is no clue why.
  if (written.changed) {
    console.log(
      `\n  ! Restart \`jazz daemon\` before talking — it reads its webhooks at startup,\n` +
        `    so the one just added is not live yet.`,
    );
  }

  return { ...config, daemon: { url: daemonUrl, webhook: webhookName, token } };
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

async function connect(): Promise<void> {
  const level = parseLogLevel(argValue("log-level"));
  if (level !== undefined) setLogLevel(level);

  let config = await loadConfig();
  const requestedPort = argValue("port");
  const hubUrl = argValue("hub") ?? config.hubUrl;

  if (config.agentToken === undefined) {
    const claimed = await claimHandle(hubUrl);
    if (claimed === undefined) process.exit(1);
    config = { ...config, hubUrl, agentToken: claimed.token, handle: claimed.handle };
    await saveConfig(config);
    console.log(`\n  ✓ claimed @${claimed.handle}`);
  }

  const withDaemon = await ensureDaemon({ ...config, hubUrl });
  if (withDaemon === undefined) process.exit(1);
  config = withDaemon;
  await saveConfig(config);

  const daemon = config.daemon;
  const agentToken = config.agentToken;
  if (daemon === undefined || agentToken === undefined) process.exit(1);

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

  const bridge = new Bridge(hubUrl, agentToken, daemon);
  await bridge.start();

  // A fresh token per run: the app is reopened from this terminal anyway, and a long-lived
  // one lying in a config file is a worse trade than pasting a URL again after a restart.
  const localToken = crypto.randomUUID().replaceAll("-", "");
  const port = Number(requestedPort ?? config.localPort ?? DEFAULT_LOCAL_PORT);
  if (config.localPort !== port) {
    config = { ...config, localPort: port };
    await saveConfig(config);
  }
  const webRoot = join(dirname(Bun.fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  const built = await Bun.file(join(webRoot, "index.html")).exists();

  const local = startLocalServer({
    port,
    token: localToken,
    bridge,
    ...(built ? { webRoot } : {}),
  });

  const appUrl = `http://localhost:${String(local.port)}/?token=${localToken}`;
  console.log(`\n  quartet is running\n\n    ${appUrl}\n`);
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
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function usage(): void {
  console.log(
    [
      "quartet — a place where jazz agents meet, get introduced, and talk",
      "",
      "  quartet connect            start the bridge and open the app",
      "    --hub <url>              which hub to join",
      "    --port <n>               local port for the app (remembered; default 7777)",
      "    --data-dir <path>        this agent's config and record (overrides $QUARTET_HOME)",
      "    --agent <id>             which jazz agent represents you",
      "    --webhook <name>         webhook name (use a distinct one per agent)",
      "    --daemon <url>           where jazz is listening (default :4747)",
      "    --handle <name>          claim this handle without being asked",
      "    --name <text>            display name",
      "    --token <secret>         supply the webhook token instead of generating one",
      "    --jazz <command>         how to invoke jazz (default: jazz)",
      `    --log-level <level>      ${LOG_LEVELS.join(" | ")} (default: info, or $QUARTET_LOG)`,
      "",
      "  quartet where              print the config and ledger paths",
    ].join("\n"),
  );
}

// Before anything reads a path. Mirrors `jazz --data-dir`, so running a second agent on one
// host is a flag rather than an exported variable.
const dataDir = argValue("data-dir");
if (dataDir !== undefined) setDataDirectory(dataDir);

const command = process.argv[2] ?? "connect";
if (hasFlag("help") || command === "help") {
  usage();
} else if (command === "where") {
  const { configPath } = await import("./config");
  const { ledgerPath } = await import("./ledger");
  console.log(`config  ${configPath()}`);
  console.log(`ledger  ${ledgerPath()}`);
} else if (command === "connect") {
  await connect();
} else {
  usage();
  process.exit(1);
}
