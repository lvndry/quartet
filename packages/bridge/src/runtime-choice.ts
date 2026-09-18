/**
 * The small, curated front door to Quartet's open runtime boundary.
 *
 * This is deliberately a catalog rather than a chain of conditionals: the prompt, CLI
 * aliases, executable checks and install advice must describe the same set of agents. The
 * final `acp` choice keeps the boundary open without downloading code from a live registry.
 */

import { resolve } from "node:path";
import type { RuntimeConfig } from "./config";

export type RuntimePreset = Exclude<RuntimeConfig, { readonly kind: "jazz" }>["preset"];
type NamedPreset = Exclude<RuntimePreset, "custom">;

interface PresetDefinition {
  readonly name: NamedPreset;
  readonly label: string;
  readonly description: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly installHint: string;
}

export const ACP_PRESETS: Readonly<Record<NamedPreset, PresetDefinition>> = {
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

export const ACP_INSTALL_HINTS: Readonly<Record<NamedPreset, string>> = Object.fromEntries(
  Object.values(ACP_PRESETS).map((preset) => [preset.name, preset.installHint]),
) as Readonly<Record<NamedPreset, string>>;

const CHOICES = [
  { name: "jazz", label: "Jazz", description: "native Quartet/Jazz runtime" },
  ACP_PRESETS.claude,
  ACP_PRESETS.codex,
  ACP_PRESETS.hermes,
  ACP_PRESETS.pi,
  { name: "acp", label: "Other", description: "any ACP v1 agent command" },
] as const;

export interface RuntimeChoiceOptions {
  readonly stored?: RuntimeConfig;
  readonly requested?: string;
  readonly cwd: string;
  readonly customCommand?: string;
  readonly customArgs?: readonly string[];
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<string | undefined>;
  readonly write?: (line: string) => void;
}

export type RuntimeChoiceResult =
  | { readonly kind: "selected"; readonly runtime: RuntimeConfig }
  | { readonly kind: "stop" }
  | { readonly kind: "error"; readonly message: string };

function presetRuntime(name: NamedPreset, cwd: string): RuntimeConfig {
  const preset = ACP_PRESETS[name];
  return {
    version: 1,
    kind: "acp",
    preset: name,
    command: preset.command,
    args: [...preset.args],
    cwd,
  };
}

function configuredLabel(runtime: RuntimeConfig | undefined): string {
  if (runtime === undefined || runtime.kind === "jazz") return "Jazz";
  if (runtime.preset === "custom") return `Other: ${runtime.command}`;
  const preset = ACP_PRESETS[runtime.preset];
  return preset?.label ?? `ACP: ${runtime.command}`;
}

function namedChoice(
  answer: string,
  options: { readonly allowNumber: boolean },
): (typeof CHOICES)[number]["name"] | undefined {
  const normalized = answer.toLowerCase();
  if (normalized === "other" || normalized === "custom") return "acp";
  const byNumber = options.allowNumber ? CHOICES[Number(normalized) - 1] : undefined;
  return byNumber?.name ?? CHOICES.find((choice) => choice.name === normalized)?.name;
}

async function customRuntime(options: RuntimeChoiceOptions): Promise<RuntimeChoiceResult> {
  let command = options.customCommand?.trim();
  if (command === undefined || command.length === 0) {
    const answer = await options.ask("  ACP executable: ");
    if (answer === undefined) return { kind: "stop" };
    command = answer.trim();
  }
  if (command.length === 0) return { kind: "error", message: "an ACP executable is required" };

  const args = options.customArgs === undefined ? [] : [...options.customArgs];
  if (options.customArgs === undefined) {
    for (;;) {
      const answer = await options.ask("  Argument (leave empty when done): ");
      if (answer === undefined) return { kind: "stop" };
      if (answer.length === 0) break;
      args.push(answer);
    }
  }

  const answer = await options.ask(`  Working directory [${options.cwd}]: `);
  if (answer === undefined) return { kind: "stop" };
  const cwd = answer.length === 0 ? resolve(options.cwd) : resolve(options.cwd, answer);
  return {
    kind: "selected",
    runtime: { version: 1, kind: "acp", preset: "custom", command, args, cwd },
  };
}

async function selectedRuntime(
  name: (typeof CHOICES)[number]["name"],
  options: RuntimeChoiceOptions,
): Promise<RuntimeChoiceResult> {
  if (name === "jazz") return { kind: "selected", runtime: { version: 1, kind: "jazz" } };
  if (name === "acp") return customRuntime(options);
  return { kind: "selected", runtime: presetRuntime(name, resolve(options.cwd)) };
}

/** Select explicitly, ask a terminal, or preserve the deterministic unattended fallback. */
export async function chooseRuntime(options: RuntimeChoiceOptions): Promise<RuntimeChoiceResult> {
  if (options.requested !== undefined) {
    const name = namedChoice(options.requested, { allowNumber: false });
    if (name === undefined) {
      return {
        kind: "error",
        message: `unknown runtime "${options.requested}" — use jazz, claude, codex, hermes, pi, or acp`,
      };
    }
    if (name === "acp" && options.customCommand === undefined) {
      return { kind: "error", message: "--runtime acp also needs --runtime-command <executable>" };
    }
    if (name === "acp") {
      return {
        kind: "selected",
        runtime: {
          version: 1,
          kind: "acp",
          preset: "custom",
          command: options.customCommand!,
          args: [...(options.customArgs ?? [])],
          cwd: resolve(options.cwd),
        },
      };
    }
    return selectedRuntime(name, options);
  }

  if (!options.interactive) {
    return { kind: "selected", runtime: options.stored ?? { version: 1, kind: "jazz" } };
  }

  const write = options.write ?? console.log;
  write("\n  Which agent should Quartet run for this identity?\n");
  for (const [index, choice] of CHOICES.entries()) {
    write(`    ${String(index + 1).padStart(2)}  ${choice.label.padEnd(8)} ${choice.description}`);
  }
  write("");

  const fallback = configuredLabel(options.stored);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer = await options.ask(`  Runtime (number or name) [${fallback}]: `);
    if (answer === undefined) return { kind: "stop" };
    if (answer.length === 0) {
      return { kind: "selected", runtime: options.stored ?? { version: 1, kind: "jazz" } };
    }
    const name = namedChoice(answer, { allowNumber: true });
    if (name !== undefined) return selectedRuntime(name, options);
    write("  That is not one of them. Pick 1-6, or type a runtime name.");
  }
  return { kind: "stop" };
}
