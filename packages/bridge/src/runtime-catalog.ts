/**
 * @fileoverview The catalog of named ACP runtimes — one place, two sources.
 *
 * Built-in presets ship here; a machine can add its own in `~/.quartet/runtimes.json` without
 * a rebuild. Both are the same shape, so the wizard, `--runtime <name>`, the executable check
 * and the install advice all describe the same set. Anything not named here still runs through
 * `--runtime acp` with an explicit command; this file is only the shortcuts.
 */

import { join } from "node:path";
import { getRootDirectory } from "./paths";

/** A named shortcut for an ACP agent: what to run, and how to help when it is missing. */
export interface PresetDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly installHint: string;
}

/**
 * The shortcuts Quartet ships. Insertion order is the order the wizard lists them, so it is
 * not incidental. Adding one here is the whole change — nothing else enumerates them.
 */
export const BUILTIN_PRESETS: Readonly<Record<string, PresetDefinition>> = {
  claude: {
    name: "claude",
    label: "Claude",
    description: "Claude Agent through ACP",
    command: "claude-agent-acp",
    args: [],
    installHint: "Install it with `npm install -g @agentclientprotocol/claude-agent-acp`.",
  },
  codex: {
    name: "codex",
    label: "Codex",
    description: "Codex through ACP",
    command: "codex-acp",
    args: [],
    installHint: "Install it with `npm install -g @agentclientprotocol/codex-acp`.",
  },
  hermes: {
    name: "hermes",
    label: "Hermes",
    description: "Hermes' native ACP server",
    command: "hermes",
    args: ["acp"],
    installHint: "Install Hermes with ACP support, then verify it with `hermes acp --check`.",
  },
  pi: {
    name: "pi",
    label: "Pi",
    description: "community ACP adapter (preview; Pi controls tools)",
    command: "pi-acp",
    args: [],
    installHint:
      "Install Pi and its community adapter with `npm install -g @earendil-works/pi-coding-agent pi-acp`.",
  },
};

/**
 * Names the catalog cannot take, because they mean something else to the runtime selector:
 * the native runtime, the ad-hoc ACP command, and its two spellings in the wizard.
 */
export const RESERVED_RUNTIME_NAMES: ReadonlySet<string> = new Set([
  "jazz",
  "acp",
  "custom",
  "other",
]);

/** Where a machine lists its own presets. Machine-level, because it names host executables. */
export function runtimeCatalogPath(): string {
  return join(getRootDirectory(), "runtimes.json");
}

/** The catalog Quartet ships, plus any this machine added, with a note per entry it rejected. */
export interface LoadedCatalog {
  readonly presets: Readonly<Record<string, PresetDefinition>>;
  /** Human-readable reasons an entry in the user file was skipped, for the operator to see. */
  readonly notes: readonly string[];
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return undefined;
  return value as readonly string[];
}

/**
 * Read the user file and fold valid entries in beside the built-ins.
 *
 * A built-in name always wins, so a stray entry can never quietly repoint `claude`; a reserved
 * name or a malformed entry is skipped with a note rather than failing the whole load. A
 * missing file is the normal case and yields the built-ins alone.
 */
export async function loadRuntimeCatalog(
  path: string = runtimeCatalogPath(),
): Promise<LoadedCatalog> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { presets: BUILTIN_PRESETS, notes: [] };

  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    return { presets: BUILTIN_PRESETS, notes: [`${path} is not valid JSON; using built-in runtimes only.`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      presets: BUILTIN_PRESETS,
      notes: [`${path} must be an object of name → runtime; using built-in runtimes only.`],
    };
  }

  const presets: Record<string, PresetDefinition> = { ...BUILTIN_PRESETS };
  const notes: string[] = [];
  for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (RESERVED_RUNTIME_NAMES.has(name.toLowerCase())) {
      notes.push(`"${name}" is a reserved name and was skipped.`);
      continue;
    }
    if (name in BUILTIN_PRESETS) {
      notes.push(`"${name}" is built in and cannot be overridden; the file's version was skipped.`);
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      notes.push(`"${name}" is not an object and was skipped.`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const command = typeof entry["command"] === "string" ? entry["command"].trim() : "";
    const args = asStringArray(entry["args"]);
    if (command.length === 0 || args === undefined) {
      notes.push(`"${name}" needs a "command" string and an optional array of string "args".`);
      continue;
    }
    presets[name] = {
      name,
      label: typeof entry["label"] === "string" && entry["label"].length > 0 ? entry["label"] : name,
      description:
        typeof entry["description"] === "string" ? entry["description"] : "runtime from runtimes.json",
      command,
      args,
      installHint:
        typeof entry["installHint"] === "string"
          ? entry["installHint"]
          : `Make sure "${command}" is installed and on your PATH.`,
    };
  }
  return { presets, notes };
}
