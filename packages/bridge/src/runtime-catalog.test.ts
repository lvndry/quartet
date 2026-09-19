import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_PRESETS, loadRuntimeCatalog } from "./runtime-catalog";

const dirs: string[] = [];

async function catalogFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "quartet-catalog-"));
  dirs.push(dir);
  const path = join(dir, "runtimes.json");
  await writeFile(path, contents);
  return path;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runtime catalog", () => {
  it("returns the built-ins when there is no file", async () => {
    const loaded = await loadRuntimeCatalog(join(tmpdir(), "quartet-catalog-absent", "runtimes.json"));
    expect(loaded.presets).toBe(BUILTIN_PRESETS);
    expect(loaded.notes).toEqual([]);
  });

  it("folds a valid user runtime in beside the built-ins, filling defaults", async () => {
    const path = await catalogFile(
      JSON.stringify({ amp: { command: "amp-acp", args: ["--stdio"], label: "Amp" } }),
    );
    const loaded = await loadRuntimeCatalog(path);
    expect(Object.keys(loaded.presets)).toEqual(["claude", "codex", "hermes", "pi", "amp"]);
    expect(loaded.presets["amp"]).toMatchObject({
      name: "amp",
      label: "Amp",
      command: "amp-acp",
      args: ["--stdio"],
    });
    expect(loaded.presets["amp"]?.installHint).toContain("amp-acp");
    expect(loaded.notes).toEqual([]);
  });

  it("never lets a user entry override a built-in or a reserved name", async () => {
    const path = await catalogFile(
      JSON.stringify({
        claude: { command: "evil" },
        jazz: { command: "evil" },
      }),
    );
    const loaded = await loadRuntimeCatalog(path);
    expect(loaded.presets["claude"]).toEqual(BUILTIN_PRESETS["claude"]);
    expect(loaded.presets["jazz"]).toBeUndefined();
    expect(loaded.notes).toHaveLength(2);
  });

  it("skips a malformed entry with a note but keeps the good ones", async () => {
    const path = await catalogFile(
      JSON.stringify({ good: { command: "good-acp" }, bad: { args: ["x"] } }),
    );
    const loaded = await loadRuntimeCatalog(path);
    expect(loaded.presets["good"]?.command).toBe("good-acp");
    expect(loaded.presets["bad"]).toBeUndefined();
    expect(loaded.notes.join(" ")).toContain('"bad"');
  });

  it("falls back to built-ins on invalid JSON", async () => {
    const path = await catalogFile("{ not json");
    const loaded = await loadRuntimeCatalog(path);
    expect(loaded.presets).toBe(BUILTIN_PRESETS);
    expect(loaded.notes.join(" ")).toContain("valid JSON");
  });
});
