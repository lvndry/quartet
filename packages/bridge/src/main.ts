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

import { basename, dirname, join } from "node:path";
import { signClaim, tag, type Keypair } from "@quartet/identity";
import { AgentAdmin } from "./agent-admin";
import { Attestor } from "./attest";
import { Bridge } from "./bridge";
import {
  hardenSecretFiles,
  DEFAULT_HUB_URL,
  isQuickTunnel,
  loadIdentityConfig,
  loadMachineConfig,
  peekIdentityConfig,
  rememberedHandle,
  saveIdentityConfig,
  saveMachineConfig,
  withHandle,
  type DaemonSettings,
  type IdentityConfig,
  type MachineConfig,
} from "./config";
import { checkHub, describeHub, explainHub } from "./hub-check";
import { loadIdentity, newIdentity, writeIdentity } from "./identity";
import { loadSealingKeys } from "./sealing-keys";
import { Sealer } from "./sealer";
import {
  currentLabel,
  getDataDirectory,
  identitiesDirectory,
  identityPath,
  isUsableLabel,
  listIdentityLabels,
  setIdentityDirectory,
  setIdentityLabel,
} from "./paths";
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
 * Loopback, and the tunnel is how it is reachable from anywhere else —
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

/**
 * What this hub calls a key — the question the config used to answer badly.
 *
 * A handle lives in the hub's database, so this is the only place the answer exists. Asked
 * before the socket, because "you have never claimed a handle here" is a thing to say to
 * somebody at a terminal, not something to discover in a reconnect loop.
 *
 * `undefined` means the hub does not know this key. `unreachable` means we do not know, which
 * is a different thing and must not be mistaken for an unclaimed key — the caller would go on
 * to offer a claim that cannot be made.
 */
async function lookupHandle(
  hubUrl: string,
  did: string,
): Promise<{ handle: string } | undefined | "unreachable"> {
  const response = await fetch(new URL(`/agents/${encodeURIComponent(did)}`, hubUrl), {
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
  if (response === undefined) return "unreachable";
  if (response.status === 404) return undefined;
  if (!response.ok) return "unreachable";
  const body = (await response.json().catch(() => null)) as { handle?: unknown } | null;
  return typeof body?.handle === "string" ? { handle: body.handle } : "unreachable";
}

/**
 * Offer this key to a hub under a name, and report what it said.
 *
 * The signature is made here rather than by the hub, which is the whole point: the hub is
 * being shown a key it cannot mint, so the name it hands back is bound to this machine.
 *
 * Shared by the terminal and by the app's claim button, so a handle claimed from a browser
 * banner is the same act as one typed at first run, and neither can drift from the other.
 */
async function postClaim(
  hubUrl: string,
  keypair: Keypair,
  handle: string,
  displayName: string,
): Promise<{ ok: true } | { error: string; status: number }> {
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
    return { error: `could not reach the hub at ${hubUrl} — is it running?`, status: 0 };
  }
  if (response.ok) return { ok: true };
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return { error: body?.error ?? "the hub refused that handle", status: response.status };
}

/**
 * Claim a handle on this hub for this key, asking which name to use.
 *
 * The question is which handle, never whether: somebody who has run `connect` against a hub
 * has already said they want to be there, and a yes/no whose answer is always yes is a
 * keystroke charged for nothing. Which name is a real question, and it is the one the old
 * flow answered on your behalf — a hub is a place you might rather be somebody else, and the
 * name you use elsewhere is not automatically the name you want here.
 *
 * Loops on a 409 rather than exiting. Handles are not unique on a hub — two people who have
 * never met are entitled to the same one, told apart by the fingerprint in the tag — so this
 * is the narrow case of a tag that would collide outright, and the fix is another word.
 */
async function claimHandle(
  hubUrl: string,
  keypair: Keypair,
  suggested: string | undefined,
): Promise<{ handle: string } | undefined> {
  const fromFlag = argValue("handle");
  const interactive = process.stdin.isTTY === true && fromFlag === undefined;
  if (interactive) console.log("\n  This hub has never seen your key.\n");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const asked = interactive
      ? await prompt(
          suggested === undefined
            ? "  Handle to claim here (lowercase, e.g. mira): "
            : `  Handle to claim here [${suggested}]: `,
        )
      : "";
    const handle = (fromFlag ?? (asked.length > 0 ? asked : (suggested ?? ""))).trim();
    if (handle.length < 2) {
      console.error("\n  A handle needs at least two characters.");
      if (!interactive) return undefined;
      continue;
    }
    // Shows the handle it falls back to, the way the daemon question shows its default. An
    // empty answer here is the common case, and a bare "Display name:" gave no clue whether
    // that meant "no display name" or "the handle".
    const nameAnswer = argValue("name") ?? (interactive ? await prompt(`  Display name: [${handle}] `) : "");
    const displayName = nameAnswer.trim().length > 0 ? nameAnswer.trim() : handle;

    const claimed = await postClaim(hubUrl, keypair, handle, displayName);
    if (!("error" in claimed)) return { handle };

    console.error(`\n  ! ${claimed.error}`);
    // A handle somebody else holds is answered by typing another one. Anything else — a
    // clock out of step, a signature the hub would not take, a rate limit — is not, and
    // asking again would just be the same refusal with more typing.
    if (claimed.status !== 409 || !interactive) return undefined;
    suggested = undefined;
  }
  return undefined;
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

/**
 * Make sure jazz has a webhook pointed at the agent this identity speaks through.
 *
 * Reads from two levels and hands back one shape. The daemon's URL is the machine's — one
 * jazz per host, and every identity on it talks to the same one. The webhook and its token
 * belong to this identity, because a webhook is per persona and its token is keyed by the
 * webhook's name in jazz's keyring.
 */
async function ensureDaemon(
  machine: MachineConfig,
  config: IdentityConfig,
): Promise<{ machine: MachineConfig; config: IdentityConfig; daemon: DaemonSettings } | undefined> {
  const daemonUrl = machine.daemonUrl;
  const webhook = config.webhook;
  if (daemonUrl !== undefined && webhook !== undefined) {
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
    const webhookName = renamed ?? webhook.name;
    // This identity's own record, falling back to jazz's entry only for a setup written
    // before quartet kept one. An `--agent` flag goes through the same check as one typed
    // at setup: it names an agent this daemon has, or connect stops. Writing it unchecked
    // pointed the webhook at nothing and only failed at the first turn, long after the
    // command said it had succeeded.
    const recorded = config.agentId ?? (await agentIdFor(webhookName));
    const agentId =
      argValue("agent") !== undefined || recorded === undefined
        ? await chooseAgent(daemonUrl)
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
    const token = needsToken ? await resolveOrMintToken(webhookName) : webhook.token;
    if (token === undefined) return undefined;
    const updated: IdentityConfig = { ...config, agentId, webhook: { name: webhookName, token } };
    return { machine, config: updated, daemon: { url: daemonUrl, webhook: webhookName, token } };
  }

  console.log("\nQuartet talks to your agent through a jazz webhook.\n");

  // The daemon first, because it is what knows which agents exist. Asking for the agent
  // before knowing where to ask was why this used to be a free-text prompt.
  const daemonAnswer =
    argValue("daemon") ?? daemonUrl ?? (await prompt(`Where is your daemon? [${DEFAULT_DAEMON_URL}] `));
  const chosenDaemon = daemonAnswer.trim().length > 0 ? daemonAnswer.trim() : DEFAULT_DAEMON_URL;

  const agentId = await chooseAgent(chosenDaemon);
  if (agentId === undefined) return undefined;

  // Named after this identity's label rather than a handle: a handle can differ from hub to
  // hub, and the keyring entry holding this webhook's token is keyed by the name. A webhook
  // that renamed itself when a hub called you something else would strand its own token.
  const webhookName = argValue("webhook") ?? defaultWebhookName(config.label);

  const written = await ensureJazzWebhook({ webhookName, agentId });
  console.log(
    written.changed
      ? `\n  ✓ wrote the "${webhookName}" webhook into ${written.path}`
      : `\n  ✓ the "${webhookName}" webhook is already configured in ${written.path}`,
  );

  const token = await resolveOrMintToken(webhookName);
  if (token === undefined) return undefined;

  return {
    machine: { ...machine, daemonUrl: chosenDaemon },
    config: { ...config, agentId, webhook: { name: webhookName, token } },
    daemon: { url: chosenDaemon, webhook: webhookName, token },
  };
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

/**
 * Which identity this run is — a folder under `~/.quartet/identities`, never the root.
 *
 * The root used to be an identity, which made this question invisible: a machine with one
 * agent and a machine that had never been asked looked identical, and whatever key happened
 * to be there was used. With one identity that is indistinguishable from working. With two it
 * is a coin toss, and with a stale one it is the bug this rewrite exists to remove.
 *
 * `new` means nothing here can sign yet and the caller should make something. It carries a
 * label only when `--identity` named one; otherwise the name is decided later, from the
 * handle the hub accepts, because that is a name already chosen.
 */
type IdentityChoice =
  | { kind: "existing"; label: string }
  | { kind: "new"; label?: string }
  | { kind: "stop" };

/**
 * A folder name for a new identity, from the handle it just claimed.
 *
 * Only a starting point. Two hubs can call two different keys the same thing, and the second
 * one to arrive here must not land in the first one's directory — so a taken name gets a
 * number rather than a collision.
 */
function uniqueLabel(handle: string, taken: readonly string[]): string {
  const base = isUsableLabel(handle) ? handle : "identity";
  if (!taken.includes(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}${String(suffix)}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${String(Date.now())}`;
}

/**
 * Repair the modes on this identity's secret files, and say so when it cannot.
 *
 * Once the identity is chosen and before anything is read out of it — a config written by an
 * older build sits at whatever the umask allowed, and it holds two bearer tokens.
 */
async function reportFilePermissions(): Promise<void> {
  for (const problem of await hardenSecretFiles()) {
    console.warn(`could not restrict permissions on a file holding secrets — ${problem}`);
  }
}

/**
 * Whether a bridge for this identity is already up on this machine, and where.
 *
 * Asked from the port and token that identity left in its own config. A stale port answers
 * nothing, or answers something that will not take this token — both of which are "no", which
 * is the right answer for a bridge that is no longer running.
 */
async function liveBridge(label: string): Promise<number | undefined> {
  const config = await peekIdentityConfig(label);
  const port = config?.localPort;
  const token = config?.localToken;
  if (port === undefined || token === undefined) return undefined;
  const response = await fetch(`http://localhost:${String(port)}/alive`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(1_500),
  }).catch(() => undefined);
  return response?.ok === true ? port : undefined;
}

/** One local identity, described in terms of the hub this run is joining. */
interface IdentityOffer {
  readonly label: string;
  /** What this hub calls it, when it has been here before. */
  readonly handle?: string;
  /** The port a bridge for it is already serving on, when one is. */
  readonly busyOn?: number;
}

async function offersFor(hubUrl: string, labels: readonly string[]): Promise<IdentityOffer[]> {
  const offers = await Promise.all(
    labels.map(async (label): Promise<IdentityOffer> => {
      const config = await peekIdentityConfig(label);
      const handle = config === undefined ? undefined : rememberedHandle(config, hubUrl);
      const busyOn = await liveBridge(label);
      return {
        label,
        ...(handle !== undefined ? { handle } : {}),
        ...(busyOn !== undefined ? { busyOn } : {}),
      };
    }),
  );
  // The ones that have been to this hub first: those are the answers to the question asked.
  return offers.sort((left, right) => Number(right.handle !== undefined) - Number(left.handle !== undefined));
}

async function chooseIdentity(
  hubUrl: string,
  options: { mayCreate: boolean },
): Promise<IdentityChoice> {
  // An explicit directory is the last word, wherever it points and whatever is in it. It is
  // how a second bridge runs from a path outside `~/.quartet` at all.
  const dataDir = argValue("data-dir");
  if (dataDir !== undefined) {
    return { kind: (await Bun.file(identityPath()).exists()) ? "existing" : "new", label: basename(dataDir) };
  }

  const known = await listIdentityLabels();
  const wanted = argValue("identity");
  if (wanted !== undefined) {
    if (!isUsableLabel(wanted)) {
      console.error(`\n  ! "${wanted}" is not a usable identity name.`);
      console.error("    Letters, digits, dot, dash and underscore; 32 characters at most.\n");
      return { kind: "stop" };
    }
    if (known.includes(wanted)) {
      if (options.mayCreate) {
        const port = await liveBridge(wanted);
        if (port !== undefined) {
          console.error(`\n  ! ${wanted} is already connected from this machine, on port ${String(port)}.`);
          console.error("    Two bridges cannot share one key: they take turns evicting each other");
          console.error("    from the hub and neither one works. Pick another --identity name to");
          console.error("    start a second agent.\n");
          return { kind: "stop" };
        }
      }
      setIdentityLabel(wanted);
      return { kind: "existing", label: wanted };
    }
    if (!options.mayCreate) {
      console.error(`\n  ! this machine has no identity called "${wanted}".`);
      console.error(`    ${known.length === 0 ? "It has none at all yet." : `It has: ${known.join(", ")}`}\n`);
      return { kind: "stop" };
    }
    setIdentityLabel(wanted);
    return { kind: "new", label: wanted };
  }

  if (known.length === 0) {
    if (options.mayCreate) return { kind: "new" };
    console.error(`\n  ! no identities in ${identitiesDirectory()}.`);
    console.error("    Run `quartet connect` to make one.\n");
    return { kind: "stop" };
  }

  const offers = await offersFor(hubUrl, known);
  const free = offers.filter((offer) => offer.busyOn === undefined);

  // A script must never stop on a question, so it gets the one unambiguous answer or an
  // error naming the flag. Only a terminal is offered the choice.
  if (process.stdin.isTTY !== true) {
    const only = free[0];
    if (free.length === 1 && only !== undefined) {
      setIdentityLabel(only.label);
      return { kind: "existing", label: only.label };
    }
    if (free.length === 0) {
      console.error(`\n  ! every identity here is already connected: ${known.join(", ")}`);
      console.error("    Two bridges cannot share one key. Start another agent by naming an");
      console.error("    identity that does not exist yet: --identity <new name>.\n");
      return { kind: "stop" };
    }
    console.error(`\n  ! this machine has several identities: ${known.join(", ")}`);
    console.error(
      `    Say which with --identity <name> — free right now: ${free.map((offer) => offer.label).join(", ")}.\n`,
    );
    return { kind: "stop" };
  }

  // Always offered, even with one identity on file and nothing running. Starting a *second*
  // agent is a thing people do, and with the door invisible the only way to find it was to
  // run `connect` again — which silently started a second bridge on the same key, and the
  // two spent the afternoon evicting each other from the hub.
  const fallback = free[0]?.label;
  console.log(`\n  Which identity on ${hubUrl}?\n`);
  for (const [index, offer] of offers.entries()) {
    const known_here = offer.handle === undefined ? "not claimed here yet" : `@${offer.handle}`;
    const busy = offer.busyOn === undefined ? "" : `  — already connected on port ${String(offer.busyOn)}`;
    console.log(`    ${String(index + 1).padStart(2)}  ${offer.label.padEnd(16)}${known_here}${busy}`);
  }
  console.log(`     n  a new one`);
  console.log("");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer = (await prompt(`  Number, name or n${fallback === undefined ? "" : ` [${fallback}]`}: `)).trim();
    if (answer === "n" || answer.toLowerCase() === "new") return { kind: "new" };
    if (answer === "" && fallback !== undefined) {
      setIdentityLabel(fallback);
      return { kind: "existing", label: fallback };
    }
    const picked = offers[Number(answer) - 1] ?? offers.find((offer) => offer.label === answer);
    if (picked === undefined) {
      console.log(`  That is not one of them. Pick 1-${String(offers.length)}, n, or type a name.`);
      continue;
    }
    if (picked.busyOn !== undefined) {
      console.log(`  ${picked.label} is already connected on port ${String(picked.busyOn)} — two bridges`);
      console.log("  cannot share one key. Pick another, or n for a new identity.");
      continue;
    }
    setIdentityLabel(picked.label);
    return { kind: "existing", label: picked.label };
  }
  return { kind: "stop" };
}

/**
 * Which hub this run joins, asked rather than assumed.
 *
 * Belonging to a hub is not a setting one configures once: a person has a hub for work and a
 * hub for friends, and picking between them should not mean remembering a flag. So the
 * question is asked every time, with the last hub as the default — one keypress to carry on
 * where you were, and a paste to go somewhere else.
 *
 * Skipped when `--hub` says which, and when there is nobody there to answer: a bridge started
 * by a script or a service manager must not stop on a question, and the stored URL is a
 * better answer than a hang.
 */
async function chooseHub(stored: string | undefined): Promise<string> {
  const fallback = stored ?? process.env["QUARTET_HUB"] ?? DEFAULT_HUB_URL;
  const fromFlag = argValue("hub");
  if (fromFlag !== undefined) return fromFlag;
  if (process.stdin.isTTY !== true) return fallback;

  const answer = await prompt(`\n  hub URL [${fallback}]: `);
  return answer === "" ? fallback : answer;
}

async function connect(): Promise<void> {
  const level = parseLogLevel(argValue("log-level"));
  if (level !== undefined) setLogLevel(level);

  if (!(await ensureJazzInstalled())) process.exit(1);

  // The hub comes first, and everything after it is asked in its terms. Which identities are
  // worth offering depends on which hub this is — a handle belongs to a hub, so the useful
  // question is "who are you *here*", and asking it the other way round meant answering it
  // from whatever identity happened to be on disk.
  let machine = await loadMachineConfig();
  const requestedPort = argValue("port");
  const hubUrl = await chooseHub(machine.lastHubUrl);

  // Checked up front rather than left to the reconnect loop, which cannot tell a hub that is
  // restarting from a name that is never coming back — and only one of those is worth waiting for.
  const check = await checkHub(hubUrl);
  if (check.kind !== "ok") {
    console.error(`\n  ! ${hubUrl} — ${describeHub(check)}`);
    for (const line of explainHub(hubUrl, check)) console.error(`    ${line}`);
    console.error("");
    process.exit(1);
  }
  if (machine.lastHubUrl !== hubUrl) {
    machine = { ...machine, lastHubUrl: hubUrl };
    await saveMachineConfig(machine);
  }

  const choice = await chooseIdentity(hubUrl, { mayCreate: true });
  if (choice.kind === "stop") process.exit(1);
  const fresh = choice.kind === "new";

  // A new identity has no directory yet, so there is nothing to read and nothing to harden
  // until its key is written — which happens once the hub has accepted a handle for it.
  let config: IdentityConfig = fresh
    ? { label: choice.label ?? "", hubUrl }
    : await loadIdentityConfig(choice.label);
  if (!fresh) await reportFilePermissions();

  // Generated but not yet kept when this identity is new: the folder is named after the
  // handle the hub accepts, so nothing is written until there is an accepted handle to name
  // it after. An abandoned first run leaves no orphan directory behind.
  const keypair = fresh ? newIdentity() : await loadIdentity();
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
        "    • leave QUARTET_APP_HOST alone and let the tunnel do it (cloudflared\n" +
        "      terminates TLS and reaches this over loopback)\n" +
        "    • set QUARTET_ALLOW_PLAINTEXT=1 if a reverse proxy in front already\n" +
        "      terminates TLS and only it can reach this port\n",
    );
    process.exit(1);
  }

  // The hub is asked what it calls this key, rather than this machine being asked what it
  // remembers. Only one of those two is the authority, and consulting the wrong one is how a
  // handle claimed against a hub that no longer exists became a reason never to claim again.
  const known = fresh ? undefined : await lookupHandle(hubUrl, keypair.did);
  if (known === "unreachable") {
    // Reachable enough to pass `checkHub` a moment ago, so this is a hub that answers some
    // routes and not others — an older build, or something in front of it. Not knowing is
    // not the same as knowing there is no claim, and offering to claim on a guess would put
    // a second handle on a hub that already had one.
    console.error(`\n  ! ${hubUrl} would not say whether it knows your key.`);
    console.error("    It answers /health but not /agents/<did>, which an older hub will do.");
    console.error("    Update the hub, or claim explicitly with --handle <name>.\n");
    process.exit(1);
  }

  if (known === undefined) {
    // Any of these may be absent, and a brand-new identity has no label yet — so an empty
    // one must not become an empty default, which read as `Handle to claim here []:`.
    const suggested = [argValue("handle"), choice.label, config.label, rememberedHandle(config, hubUrl)]
      .map((candidate) => candidate?.trim())
      .find((candidate) => candidate !== undefined && candidate.length > 0);
    const claimed = await claimHandle(hubUrl, keypair, suggested);
    if (claimed === undefined) process.exit(1);

    // Only now does a new identity get a folder: the handle is accepted, so there is a name
    // to give it that nothing else on this machine holds.
    if (fresh) {
      const label = choice.label ?? uniqueLabel(claimed.handle, await listIdentityLabels());
      setIdentityLabel(label);
      const written = await writeIdentity(keypair);
      if (written !== undefined) {
        console.error(`\n${written.error}`);
        process.exit(1);
      }
      config = { ...config, label };
    }
    config = withHandle({ ...config, hubUrl }, hubUrl, claimed.handle);
    await saveIdentityConfig(config);
    console.log(`\n  ✓ claimed ${tag(claimed.handle, keypair.did) ?? `@${claimed.handle}`}`);
    console.log("    Give that whole line to anyone inviting you — the part after # is what");
    console.log("    proves the handle is yours and not somebody wearing your name.");
    if (fresh) console.log(`    Kept in ${getDataDirectory()}`);
  } else {
    config = withHandle({ ...config, hubUrl }, hubUrl, known.handle);
  }
  const handle = rememberedHandle(config, hubUrl);

  const withDaemon = await ensureDaemon(machine, { ...config, hubUrl });
  if (withDaemon === undefined) process.exit(1);
  machine = withDaemon.machine;
  config = withDaemon.config;
  const daemon = withDaemon.daemon;
  await saveMachineConfig(machine);
  await saveIdentityConfig(config);

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
    await saveIdentityConfig(config);
  });
  const preferredPort = Number(requestedPort ?? config.localPort ?? DEFAULT_LOCAL_PORT);
  const appRoot = join(dirname(Bun.fileURLToPath(import.meta.url)), "..", "..", "app", "dist");
  const built = await Bun.file(join(appRoot, "index.html")).exists();

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
    // A hub can lose this key while the bridge is running — a replaced database, a restore
    // from before this identity existed. `connect` finished long ago and its terminal has
    // moved on, so the page is the only place left that can offer the repair.
    claim: async (wanted: string) => {
      const claimed = await postClaim(hubUrl, keypair, wanted, wanted);
      if ("error" in claimed) return { error: claimed.error };
      config = withHandle(config, hubUrl, wanted);
      await saveIdentityConfig(config);
      logger("bridge").info("claimed a handle", { handle: `@${wanted}`, hub: hubUrl });
      return { ok: true as const };
    },
    hostname: APP_HOST,
    ...(built ? { appRoot } : {}),
  });

  if (local.port !== preferredPort) {
    console.log(`\n  port ${String(preferredPort)} was taken, so this agent took ${String(local.port)}.`);
  }

  // Remember whichever port it settled on, so the next start comes back to the same URL
  // without a flag even when it had to move up from the preferred one.
  if (config.localPort !== local.port) config = { ...config, localPort: local.port };
  await saveIdentityConfig(config);

  const appUrl = `http://localhost:${String(local.port)}/?token=${localToken}`;
  console.log(`\n  quartet is running\n\n    ${appUrl}\n`);

  // The tunnel comes up after the server, because a quick tunnel needs a port that is already
  // listening. Failing to get one is a warning rather than an exit: the app on this machine
  // works either way, and losing it because a phone could not be reached would be the wrong
  // trade.
  let stopTunnel: (() => void) | undefined;
  if (!hasFlag("no-expose")) {
    console.log("  getting an address a phone can reach — cloudflare quick tunnel…");
    const tunnel = await startTunnel(local.port);
    if (tunnel.kind === "ok") {
      local.setPublicOrigin(tunnel.url);
      stopTunnel = tunnel.stop;
      console.log(`\n  ✓ also reachable at ${tunnel.url}`);
      console.log("    Nothing can get in with that URL alone.\n");

      // Exposing the app and then being told to run a second command to use it is a
      // two-step for something that is one intention. The exception is a bridge that
      // already has devices on it: a code nobody asked for is a credential sitting on a
      // screen, and re-pairing a phone you already paired is not why you passed the flag.
      if (devices.list().length === 0) {
        const offer = devices.offerPairing();
        console.log(await QRCode.toString(`${tunnel.url}/pair?code=${offer.code}`, {
          type: "terminal",
          small: true,
        }));
        console.log(`  scan that to pair a device — the code is ${offer.code}`);
        console.log(`  good for two minutes. \`bun run bridge pair${identityFlags()}\` for another,`);
        console.log("  or `--no-expose` if you would rather this machine were the only way in.\n");
      } else {
        const paired = devices.list();
        const names = paired.map((device) => device.name).join(", ");
        console.log(`  ${String(paired.length)} device${paired.length === 1 ? "" : "s"} paired: ${names}`);
        console.log(`  \`bun run bridge pair${identityFlags()}\` to add another.\n`);
      }
    } else {
      // Not fatal, and deliberately so: the app on this machine works either way, and a
      // connect that fails because a phone could not be reached would be the wrong trade —
      // especially now that nobody asked for the tunnel by name.
      console.warn(`\n  ! no tunnel (${tunnel.kind}) — the app is still on ${appUrl}`);
      console.warn("    That is only the phone address; your agent is connected and working.\n");
    }
  }
  logger("bridge").info("watching", {
    agent: handle === undefined ? config.label : `@${handle}`,
    webhook: daemon.webhook,
    data: getDataDirectory(),
    level: currentLogLevel(),
  });
  if (!built) {
    console.log("  (no app build yet — run `bun run app:build`, or `bun run app:dev` to develop)\n");
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
  const machine = await loadMachineConfig();
  const choice = await chooseIdentity(argValue("hub") ?? machine.lastHubUrl ?? DEFAULT_HUB_URL, {
    mayCreate: false,
  });
  if (choice.kind !== "existing") process.exit(1);
  await reportFilePermissions();
  const config = await loadIdentityConfig(choice.label);
  if (config.localPort === undefined || config.localToken === undefined) {
    console.error(`\n  ! no app on file in ${getDataDirectory()}.`);
    console.error("    That is the directory --identity/--data-dir picked, and nothing has run");
    console.error("    `quartet connect` there yet. A bridge started with `--data-dir <path>`");
    console.error("    is paired with the same `--data-dir <path>`, not with `--identity`.\n");
    process.exit(1);
  }

  const known = rememberedHandle(config, config.hubUrl);
  console.log(
    `\n  pairing a device to ${known === undefined ? config.label : `@${known}`}` +
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
    console.error("    Start it with `quartet connect`, then run this again — or pass");
    console.error("    `--identity <name>` if you meant one of the other bridges here.\n");
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
        "\n    without `--no-expose` so there is an address it can reach.\n",
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
  const label = currentLabel();
  return label === undefined ? "" : ` --identity ${label}`;
}

function usage(): void {
  console.log(
    [
      "quartet — a place where jazz agents meet, get introduced, and talk",
      "",
      "  quartet connect            start the bridge and open the app",
      "    --identity <name>        which identity on this machine to be, skipping the",
      "                             question — a name it does not know makes a new one",
      "    --hub <url>              which hub to join",
      "    --no-expose              skip the public https URL, so the app is reachable from",
      "                             this machine only and no phone can pair with it",
      "    --port <n>               local port for the app — served or nothing (default 7777,",
      "                             and only that default moves up when it is taken)",
      "    --data-dir <path>        this identity's folder, wherever it is",
      "    --agent <id>             which jazz agent represents you",
      "    --webhook <name>         webhook name (default: quartet-<identity>)",
      "    --daemon <url>           where jazz is listening (default :4747)",
      "    --handle <name>          claim this handle on that hub without being asked",
      "    --name <text>            display name",
      "    --token <secret>         supply the webhook token instead of generating one",
      "    --new-token              mint a fresh webhook token and save it, for when jazz",
      "                             has started rejecting the one on file",
      "    --jazz <command>         how to invoke jazz (default: jazz)",
      `    --log-level <level>      ${LOG_LEVELS.join(" | ")} (default: info, or $QUARTET_LOG)`,
      "    --yes                    install jazz without asking, if it's missing",
      "",
      "  quartet pair                offer a code for a phone or tablet to scan",
      "    --identity <name>          pair to one of the identities on this host",
      "    --data-dir <path>          the same, by directory",
      "",
      "  quartet info                what this identity actually is, right now",
      "    --identity <name>          which identity to describe",
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
  const machine = await loadMachineConfig();
  const choice = await chooseIdentity(argValue("hub") ?? machine.lastHubUrl ?? DEFAULT_HUB_URL, {
    mayCreate: false,
  });
  if (choice.kind !== "existing") process.exit(1);
  await reportFilePermissions();
  const config = await loadIdentityConfig(choice.label);

  console.log(`identity   ${config.label}`);
  console.log(`data dir   ${getDataDirectory()}`);

  // `loadIdentity` generates a keypair when none exists — right for `connect`, wrong for a
  // command that only looks. Checking first means asking about a directory nothing has
  // touched yet leaves it exactly as untouched as it was.
  if (!(await Bun.file(identityPath()).exists())) {
    console.log(`key        none yet — generated on first connect`);
  } else {
    const identity = await loadIdentity();
    if ("error" in identity) {
      console.log(`key        ${identity.error}`);
    } else {
      console.log(`key        ${identity.did}`);
    }
  }

  const hubUrl = argValue("hub") ?? config.hubUrl;
  const check = await checkHub(hubUrl);
  // Only while it is still working, which is when the warning is worth anything. Once the name
  // has already moved, `explainHub` says the same thing at more length and to more purpose.
  const naming =
    check.kind === "ok" && isQuickTunnel(hubUrl)
      ? " (quick tunnel — this name changes when the hub restarts)"
      : "";
  console.log(`hub        ${hubUrl} — ${describeHub(check)}${naming}`);
  for (const line of explainHub(hubUrl, check)) console.log(`           ${line}`);

  const known = rememberedHandle(config, hubUrl);
  console.log(`handle     ${known === undefined ? "none claimed on that hub yet" : `@${known}`}`);

  const daemonUrl = argValue("daemon") ?? machine.daemonUrl ?? DEFAULT_DAEMON_URL;
  const agentFlag =
    argValue("agent") ??
    config.agentId ??
    (config.webhook !== undefined ? await agentIdFor(config.webhook.name) : undefined);

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

  if (config.webhook !== undefined) {
    console.log(`webhook    ${config.webhook.name}`);
  }
}

// Before anything reads a path. Mirrors `jazz --data-dir`, so running a bridge from a
// directory outside `~/.quartet` is a flag rather than an exported variable.
//
// Only `--data-dir` is settled here, because it is the one answer that needs nothing else:
// `--identity`, the single identity on a machine that has one, and the question asked when
// there are several are all resolved per command, where there is somebody to ask.
const dataDir = argValue("data-dir");
if (dataDir !== undefined) setIdentityDirectory(dataDir);

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
