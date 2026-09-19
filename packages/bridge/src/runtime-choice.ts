/**
 * The small, curated front door to Quartet's open runtime boundary.
 *
 * This is deliberately a catalog rather than a chain of conditionals: the prompt, CLI
 * aliases, executable checks and install advice must describe the same set of agents. The
 * catalog itself lives in `runtime-catalog.ts`, which folds in whatever a machine adds in
 * `~/.quartet/runtimes.json`; the final `acp` choice keeps the boundary open for anything not
 * named there, without downloading code from a live registry.
 */

import { resolve } from "node:path";
import type { RuntimeConfig } from "./config";
import { BUILTIN_PRESETS, type PresetDefinition } from "./runtime-catalog";

export type RuntimePreset = Exclude<RuntimeConfig, { readonly kind: "jazz" }>["preset"];

/** Kept for callers and tests that want the shipped install advice by name. */
export const ACP_INSTALL_HINTS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(BUILTIN_PRESETS).map((preset) => [preset.name, preset.installHint]),
);

interface Choice {
  readonly name: string;
  readonly label: string;
  readonly description: string;
}

/** Jazz first (the default), the catalog in its own order, then the open `acp` door last. */
function choicesFor(catalog: Readonly<Record<string, PresetDefinition>>): readonly Choice[] {
  return [
    { name: "jazz", label: "Jazz", description: "native Quartet/Jazz runtime" },
    ...Object.values(catalog).map((preset) => ({
      name: preset.name,
      label: preset.label,
      description: preset.description,
    })),
    { name: "acp", label: "Other", description: "any ACP v1 agent command" },
  ];
}

export interface RuntimeChoiceOptions {
  readonly stored?: RuntimeConfig;
  readonly requested?: string;
  readonly cwd: string;
  readonly customCommand?: string;
  readonly customArgs?: readonly string[];
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<string | undefined>;
  readonly write?: (line: string) => void;
  /** The named runtimes to offer. Defaults to the shipped built-ins when a caller has no file. */
  readonly catalog?: Readonly<Record<string, PresetDefinition>>;
}

export type RuntimeChoiceResult =
  | { readonly kind: "selected"; readonly runtime: RuntimeConfig }
  | { readonly kind: "stop" }
  | { readonly kind: "error"; readonly message: string };

function presetRuntime(
  name: string,
  cwd: string,
  catalog: Readonly<Record<string, PresetDefinition>>,
): RuntimeConfig {
  const preset = catalog[name];
  return {
    version: 1,
    kind: "acp",
    preset: name,
    command: preset?.command ?? name,
    args: [...(preset?.args ?? [])],
    cwd,
  };
}

function configuredLabel(
  runtime: RuntimeConfig | undefined,
  catalog: Readonly<Record<string, PresetDefinition>>,
): string {
  if (runtime === undefined || runtime.kind === "jazz") return "Jazz";
  if (runtime.preset === "custom") return `Other: ${runtime.command}`;
  return catalog[runtime.preset]?.label ?? `ACP: ${runtime.command}`;
}

function namedChoice(
  answer: string,
  options: { readonly allowNumber: boolean },
  choices: readonly Choice[],
): string | undefined {
  const normalized = answer.toLowerCase();
  if (normalized === "other" || normalized === "custom") return "acp";
  const byNumber = options.allowNumber ? choices[Number(normalized) - 1] : undefined;
  return byNumber?.name ?? choices.find((choice) => choice.name.toLowerCase() === normalized)?.name;
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
  name: string,
  options: RuntimeChoiceOptions,
  catalog: Readonly<Record<string, PresetDefinition>>,
): Promise<RuntimeChoiceResult> {
  if (name === "jazz") return { kind: "selected", runtime: { version: 1, kind: "jazz" } };
  if (name === "acp") return customRuntime(options);
  return { kind: "selected", runtime: presetRuntime(name, resolve(options.cwd), catalog) };
}

/** Select explicitly, ask a terminal, or preserve the deterministic unattended fallback. */
export async function chooseRuntime(options: RuntimeChoiceOptions): Promise<RuntimeChoiceResult> {
  const catalog = options.catalog ?? BUILTIN_PRESETS;
  const choices = choicesFor(catalog);

  if (options.requested !== undefined) {
    const name = namedChoice(options.requested, { allowNumber: false }, choices);
    if (name === undefined) {
      const names = ["jazz", ...Object.keys(catalog)].join(", ");
      return {
        kind: "error",
        message: `unknown runtime "${options.requested}" — use ${names}, or acp`,
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
    return selectedRuntime(name, options, catalog);
  }

  if (!options.interactive) {
    return { kind: "selected", runtime: options.stored ?? { version: 1, kind: "jazz" } };
  }

  const write = options.write ?? console.log;
  write("\n  Which agent should Quartet run for this identity?\n");
  for (const [index, choice] of choices.entries()) {
    write(`    ${String(index + 1).padStart(2)}  ${choice.label.padEnd(8)} ${choice.description}`);
  }
  write("");

  const fallback = configuredLabel(options.stored, catalog);
  const highest = choices.length;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer = await options.ask(`  Runtime (number or name) [${fallback}]: `);
    if (answer === undefined) return { kind: "stop" };
    if (answer.length === 0) {
      return { kind: "selected", runtime: options.stored ?? { version: 1, kind: "jazz" } };
    }
    const name = namedChoice(answer, { allowNumber: true }, choices);
    if (name !== undefined) return selectedRuntime(name, options, catalog);
    write(`  That is not one of them. Pick 1-${String(highest)}, or type a runtime name.`);
  }
  return { kind: "stop" };
}
