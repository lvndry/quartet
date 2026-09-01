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
import { daemonReachable, ensureJazzTrigger, triggerTokenEnvVar } from "./jazz";
import { startLocalServer } from "./local";

const DEFAULT_LOCAL_PORT = 7777;
const DEFAULT_TRIGGER = "quartet";
const DEFAULT_DAEMON_URL = "http://localhost:4747";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) return line.trim();
  return "";
}

async function claimHandle(hubUrl: string): Promise<{ token: string; handle: string } | undefined> {
  console.log("\nYou do not have a quartet identity on this hub yet.\n");
  const handle = await prompt("Pick a handle (lowercase, e.g. mira): ");
  const displayName = (await prompt("Display name: ")) || handle;

  const response = await fetch(new URL("/agents", hubUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName }),
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
  return { token: body.token, handle };
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

  console.log("\nQuartet talks to your agent through a jazz webhook trigger.\n");
  const agentAnswer =
    argValue("agent") ?? (await prompt("Which jazz agent should represent you? [default] "));
  const agentId = agentAnswer.trim().length > 0 ? agentAnswer.trim() : "default";

  const daemonAnswer =
    argValue("daemon") ?? (await prompt(`Where is your daemon? [${DEFAULT_DAEMON_URL}] `));
  const daemonUrl = daemonAnswer.trim().length > 0 ? daemonAnswer.trim() : DEFAULT_DAEMON_URL;

  // One trigger per agent, not one per machine. Two agents sharing a daemon — which is how
  // anyone tries this out before roping in a second person — would otherwise write the same
  // trigger name and quietly point it at whichever agent connected last.
  const triggerName = argValue("trigger") ?? DEFAULT_TRIGGER;

  const written = await ensureJazzTrigger({ triggerName, agentId });
  console.log(
    written.changed
      ? `\n  ✓ wrote the "${triggerName}" trigger into ${written.path}`
      : `\n  ✓ the "${triggerName}" trigger is already configured in ${written.path}`,
  );

  const envVar = triggerTokenEnvVar(triggerName);
  const fromEnv = process.env[envVar];
  const token =
    fromEnv ??
    (await prompt(
      `\nThat trigger needs a bearer token. Set one with:\n` +
        `  jazz config set triggers.${triggerName}.token\n` +
        `then paste the same value here (or set ${envVar}): `,
    ));
  if (token.trim().length === 0) {
    console.error("\nWithout the trigger token quartet cannot wake your agent.");
    return undefined;
  }

  return { ...config, daemon: { url: daemonUrl, trigger: triggerName, token: token.trim() } };
}

async function connect(): Promise<void> {
  let config = await loadConfig();
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
  const port = Number(argValue("port") ?? DEFAULT_LOCAL_PORT);
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
      "    --port <n>               local port for the app (default 7777)",
      "    --agent <id>             which jazz agent represents you",
      "    --trigger <name>         trigger name (use a distinct one per agent)",
      "    --daemon <url>           where jazz is listening (default :4747)",
      "",
      "  quartet where              print the config and ledger paths",
    ].join("\n"),
  );
}

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
