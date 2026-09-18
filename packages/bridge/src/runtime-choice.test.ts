import { describe, expect, it } from "bun:test";
import type { RuntimeConfig } from "./config";
import { ACP_INSTALL_HINTS, chooseRuntime } from "./runtime-choice";

function chooser(
  answers: readonly (string | undefined)[],
  overrides: Partial<Parameters<typeof chooseRuntime>[0]> = {},
) {
  const remaining = [...answers];
  const questions: string[] = [];
  const output: string[] = [];
  return {
    questions,
    output,
    result: chooseRuntime({
      cwd: "/work/project",
      interactive: true,
      ask: (question) => {
        questions.push(question);
        return Promise.resolve(remaining.shift());
      },
      write: (line) => output.push(line),
      ...overrides,
    }),
  };
}

describe("choosing an agent runtime", () => {
  it("offers the curated agents and keeps Jazz as the first-run default", async () => {
    const choice = chooser([""]);
    expect(await choice.result).toEqual({
      kind: "selected",
      runtime: { version: 1, kind: "jazz" },
    });
    expect(choice.output.join("\n")).toContain("Claude");
    expect(choice.output.join("\n")).toContain("Hermes");
    expect(choice.output.join("\n")).toContain("Pi");
    expect(choice.output.join("\n")).toContain("Other");
  });

  it.each([
    ["2", "claude", "claude-agent-acp", []],
    ["codex", "codex", "codex-acp", []],
    ["4", "hermes", "hermes", ["acp"]],
    ["PI", "pi", "pi-acp", []],
  ] as const)("maps %s to the %s ACP preset", async (answer, preset, command, args) => {
    expect(await chooser([answer]).result).toEqual({
      kind: "selected",
      runtime: { version: 1, kind: "acp", preset, command, args: [...args], cwd: "/work/project" },
    });
  });

  it("preserves the stored runtime exactly when Enter accepts the default", async () => {
    const stored: RuntimeConfig = {
      version: 1,
      kind: "acp",
      preset: "custom",
      command: "/opt/My Agent/agent",
      args: ["--literal", "two words"],
      cwd: "/stored/project",
    };
    const choice = chooser([""], { stored });
    expect(await choice.result).toEqual({ kind: "selected", runtime: stored });
    expect(choice.questions[0]).toContain("[Other: /opt/My Agent/agent]");
  });

  it("keeps custom commands and arguments as argv, never shell text", async () => {
    const choice = chooser(["other", "/opt/My Agent/agent", "--stdio", "two words", "", "./workspace"]);
    expect(await choice.result).toEqual({
      kind: "selected",
      runtime: {
        version: 1,
        kind: "acp",
        preset: "custom",
        command: "/opt/My Agent/agent",
        args: ["--stdio", "two words"],
        cwd: "/work/project/workspace",
      },
    });
  });

  it("uses explicit flags without asking anything", async () => {
    const choice = chooser([], {
      requested: "acp",
      customCommand: "my-agent-acp",
      customArgs: ["--stdio"],
      stored: { version: 1, kind: "jazz" },
    });
    expect(await choice.result).toEqual({
      kind: "selected",
      runtime: {
        version: 1,
        kind: "acp",
        preset: "custom",
        command: "my-agent-acp",
        args: ["--stdio"],
        cwd: "/work/project",
      },
    });
    expect(choice.questions).toEqual([]);
  });

  it("keeps numeric shortcuts inside the wizard and documents Pi's adapter", async () => {
    expect(await chooser([], { requested: "1" }).result).toMatchObject({ kind: "error" });
    expect(ACP_INSTALL_HINTS.pi).toContain("@earendil-works/pi-coding-agent pi-acp");
  });

  it("never asks when unattended, preserving stored and legacy defaults", async () => {
    const stored: RuntimeConfig = {
      version: 1,
      kind: "acp",
      preset: "pi",
      command: "pi-acp",
      args: [],
      cwd: "/work/project",
    };
    const existing = chooser([], { interactive: false, stored });
    expect(await existing.result).toEqual({ kind: "selected", runtime: stored });
    expect(existing.questions).toEqual([]);

    const legacy = chooser([], { interactive: false });
    expect(await legacy.result).toEqual({
      kind: "selected",
      runtime: { version: 1, kind: "jazz" },
    });
    expect(legacy.questions).toEqual([]);
  });

  it("retries invalid input and treats EOF as cancellation", async () => {
    const choice = chooser(["wat", undefined]);
    expect(await choice.result).toEqual({ kind: "stop" });
    expect(choice.output.at(-1)).toContain("not one of them");
  });

  it("rejects an unknown explicit runtime and a commandless custom runtime", async () => {
    expect(await chooser([], { requested: "unknown" }).result).toMatchObject({ kind: "error" });
    expect(await chooser([], { requested: "acp" }).result).toEqual({
      kind: "error",
      message: "--runtime acp also needs --runtime-command <executable>",
    });
  });
});
