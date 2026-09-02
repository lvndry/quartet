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
import { signClaim, tag, type Keypair } from "@quartet/identity";
import { Attestor } from "./attest";
import { Bridge } from "./bridge";
import { loadConfig, saveConfig, type QuartetConfig } from "./config";
import { loadIdentity } from "./identity";
import { getDataDirectory, setDataDirectory } from "./paths";
import {
  daemonReachable,
  ensureJazzWebhook,
  jazzConfigPath,
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

const DEFAULT_LOCAL_PORT = 7777;
const DEFAULT_WEBHOOK = "quartet";
const DEFAULT_DAEMON_URL = "http://localhost:4747";

/**
 * A flag's value, straight off argv — and refuses to hand back another flag's name as if it
 * were one.
 *
 * `--data-dir --hub https://…` is a real command somebody will type, from putting the wrong
 * flag first or dropping a value by mistake, and every flag here happens to be the kind of
 * thing that never legitimately starts with `--` — a handle, a URL, a path, a port. Handing
 * back `"--hub"` as `--data-dir`'s value used to mean silently working from the wrong
 * directory with no error at all; the mistake surfaced only much later, as a stale identity
 * a fresh hub had never heard of.
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
  const handle = fromFlag ?? (await prompt("Pick a handle (lowercase, e.g. mira): "));
  if (handle.trim().length < 2) {
    console.error("\nA handle needs at least two characters.");
    return undefined;
  }
  const nameAnswer = argValue("name") ?? (await prompt("Display name: "));
  const displayName = nameAnswer.trim().length > 0 ? nameAnswer.trim() : handle.trim();

  // The claim is signed here rather than by the hub, which is the whole point: the hub is
  // being shown a key it cannot mint, so the name it hands back is bound to this machine.
  const claim = { did: keypair.did, handle: handle.trim(), at: new Date().toISOString() };
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
  return { handle: handle.trim() };
}

/**
 * Make sure jazz has a trigger pointed at the agent quartet should speak as.
 *
 * The token is never written into the config file — jazz reads it from the keyring or the
 * environment, and putting a bearer token in a JSON file on disk would be a downgrade from
 * where jazz already keeps it.
 */
/**
 * Choose which of this machine's jazz agents speaks for its owner in quartet.
 *
 * Shown rather than typed from memory. The agent decides what quartet can actually do — a
 * model with no calendar tool cannot answer a question about your week however well it is
 * prompted — so provider, model and tools belong in front of somebody making this choice.
 *
 * Returns the agent's id. `undefined` means give up, and the caller stops rather than
 * writing a webhook pointing at nothing.
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
    const existing = argValue("agent") ?? (await agentIdFor(config.daemon.webhook));
    const agentId = existing ?? (await chooseAgent(config.daemon.url));
    if (agentId === undefined) return undefined;
    const refreshed = await ensureJazzWebhook({
      webhookName: config.daemon.webhook,
      agentId,
    });
    if (refreshed.changed) {
      console.log(`\n  ✓ refreshed the "${config.daemon.webhook}" prompt in ${refreshed.path}`);
    }
    return config;
  }

  console.log("\nQuartet talks to your agent through a jazz webhook.\n");

  // The daemon first, because it is what knows which agents exist. Asking for the agent
  // before knowing where to ask was why this used to be a free-text prompt.
  const daemonAnswer =
    argValue("daemon") ?? (await prompt(`Where is your daemon? [${DEFAULT_DAEMON_URL}] `));
  const daemonUrl = daemonAnswer.trim().length > 0 ? daemonAnswer.trim() : DEFAULT_DAEMON_URL;

  const agentId = await chooseAgent(daemonUrl);
  if (agentId === undefined) return undefined;

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

/**
 * The agent a webhook already points at, so refreshing its prompt leaves that alone.
 *
 * `undefined` when there is nothing recorded, which the caller turns into a question. It
 * used to answer "default" — a persona name that matches no agent — so a webhook missing
 * its agent was quietly rewritten to point at one that does not exist.
 */
async function agentIdFor(webhookName: string): Promise<string | undefined> {
  const file = Bun.file(jazzConfigPath());
  if (!(await file.exists())) return undefined;
  const config = (await file.json().catch(() => ({}))) as {
    webhooks?: { name?: string; agentId?: string }[];
  };
  const entry = config.webhooks?.find((webhook) => webhook.name === webhookName);
  const agentId = entry?.agentId;
  return typeof agentId === "string" && agentId.length > 0 ? agentId : undefined;
}

/**
 * What jazz says this webhook's agent is running, for the app header.
 *
 * Best-effort: an older jazz without `GET /agents`, a daemon that is not up yet, or a
 * webhook with no agent recorded on file all just mean the header omits the line rather
 * than the app failing to start over it.
 */
async function currentModel(daemon: QuartetConfig["daemon"]): Promise<string | undefined> {
  if (daemon === undefined) return undefined;
  const agentId = await agentIdFor(daemon.webhook);
  if (agentId === undefined) return undefined;
  const listing = await fetchJazzAgents(daemon.url);
  if (listing.kind !== "ok") return undefined;
  const agent = listing.agents.find((candidate) => candidate.id === agentId);
  if (agent === undefined || (agent.provider === undefined && agent.model === undefined)) {
    return undefined;
  }
  return describeModel(agent);
}

/**
 * Whether the hub is answering right now.
 *
 * Checked once, up front, rather than left to the bridge's own reconnect loop: that loop
 * treats every disconnect the same — a hub restarting and a URL that will never resolve both
 * just retry forever with the same generic log line. A typo survives that indefinitely with
 * no signal beyond a warning easy to miss; failing here instead means it is caught before
 * anything else about this run even starts.
 *
 * A 200 alone is not enough: a mistyped domain can resolve to a parked-domain page that
 * answers every path with a 200 of its own HTML, which would otherwise pass this check while
 * being nothing like a hub. Requiring the exact body this hub's own `/health` returns is what
 * tells the two apart.
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

async function connect(): Promise<void> {
  const level = parseLogLevel(argValue("log-level"));
  if (level !== undefined) setLogLevel(level);

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

  const myModel = await currentModel(daemon);
  const bridge = new Bridge(hubUrl, daemon, new Attestor(keypair), undefined, myModel);
  await bridge.start();

  const localToken = config.localToken ?? crypto.randomUUID().replaceAll("-", "");
  if (config.localToken !== localToken) config = { ...config, localToken };
  const preferredPort = Number(requestedPort ?? config.localPort ?? DEFAULT_LOCAL_PORT);
  const webRoot = join(dirname(Bun.fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  const built = await Bun.file(join(webRoot, "index.html")).exists();

  const local = startLocalServer({
    port: preferredPort,
    token: localToken,
    bridge,
    ...(built ? { webRoot } : {}),
  });

  // Remember whichever port it settled on, so the next start comes back to the same URL
  // without a flag even when it had to move up from the preferred one.
  if (config.localPort !== local.port) config = { ...config, localPort: local.port };
  await saveConfig(config);

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
      "    --port <n>               local port for the app (default 7777, next free one if taken)",
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
  const { asidesPath } = await import("./paths");
  console.log(`config  ${configPath()}`);
  console.log(`ledger  ${ledgerPath()}`);
  console.log(`asides  ${asidesPath()}`);
} else if (command === "connect") {
  await connect();
} else {
  usage();
  process.exit(1);
}
