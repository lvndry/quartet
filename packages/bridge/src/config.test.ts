/**
 * @fileoverview Whether the files holding secrets are readable by anybody but their owner.
 *
 * `config.json` holds the jazz webhook's bearer token, which wakes the local agent and can
 * spend its owner's model budget, and the local app's token, which is the whole of what
 * guards a page showing every conversation on this machine. `identity.json` holds the private
 * key. The mode on those is not a detail, and it was left to the umask.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenSecretFiles, loadConfig, saveConfig } from "./config";
import { configPath, identityPath, setDataDirectory } from "./paths";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "quartet-config-"));
  setDataDirectory(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Just the permission bits, which is all any of this is about. */
async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("saving config", () => {
  it("writes it owner-only, whatever the umask would have allowed", async () => {
    await saveConfig({
      hubUrl: "http://localhost:8080",
      daemon: { url: "http://127.0.0.1:4321", webhook: "quartet", token: "a-bearer-token" },
      localToken: "guards-the-local-app",
    });

    expect(await modeOf(configPath())).toBe(0o600);
  });

  it("still reads back what it wrote", async () => {
    await saveConfig({ hubUrl: "http://example.test", handle: "mira" });
    const read = await loadConfig();

    expect(read.handle).toBe("mira");
    expect(read.hubUrl).toBe(process.env["QUARTET_HUB"] ?? "http://example.test");
  });

  it("leaves no temporary file behind for anyone to read", async () => {
    await saveConfig({ hubUrl: "http://example.test" });
    const strays = [...new Bun.Glob("*.tmp").scanSync(workDir)];

    expect(strays).toEqual([]);
  });
});

describe("repairing what is already on disk", () => {
  it("narrows a config written world-readable by an older build", async () => {
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath(), '{"hubUrl":"http://localhost:8080"}\n');
    await chmod(configPath(), 0o644);
    await writeFile(identityPath(), '{"did":"did:key:zX","privateKey":"k"}\n');
    await chmod(identityPath(), 0o604);

    // The common case is not a fresh install: it is a file written months ago that has been
    // sitting readable ever since, and would stay that way until something rewrote it.
    expect(await hardenSecretFiles()).toEqual([]);

    expect(await modeOf(configPath())).toBe(0o600);
    expect(await modeOf(identityPath())).toBe(0o600);
  });

  it("says nothing and does nothing when there is nothing there", async () => {
    expect(await hardenSecretFiles()).toEqual([]);
  });

  it("leaves an already-tight file alone", async () => {
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath(), "{}\n", { mode: 0o600 });
    await chmod(configPath(), 0o600);

    expect(await hardenSecretFiles()).toEqual([]);
    expect(await modeOf(configPath())).toBe(0o600);
  });
});
