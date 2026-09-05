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
import {
  hardenSecretFiles,
  isQuickTunnel,
  loadIdentityConfig,
  rememberedHandle,
  saveIdentityConfig,
  withHandle,
} from "./config";
import { configPath, identityPath, setIdentityDirectory } from "./paths";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "quartet-config-"));
  setIdentityDirectory(workDir);
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
    await saveIdentityConfig({
      label: "mira",
      hubUrl: "http://localhost:8080",
      webhook: { name: "quartet-mira", token: "a-bearer-token" },
      localToken: "guards-the-local-app",
    });

    expect(await modeOf(configPath())).toBe(0o600);
  });

  it("still reads back what it wrote", async () => {
    await saveIdentityConfig(
      withHandle({ label: "mira", hubUrl: "http://example.test" }, "http://example.test", "mira"),
    );
    const read = await loadIdentityConfig("mira");

    expect(read.label).toBe("mira");
    expect(read.hubUrl).toBe(process.env["QUARTET_HUB"] ?? "http://example.test");
    expect(rememberedHandle(read, "http://example.test")).toBe("mira");
  });

  it("keeps one handle per hub, because a handle belongs to a hub and not to a key", async () => {
    const both = withHandle(
      withHandle({ label: "mira", hubUrl: "http://work.test" }, "http://work.test", "mira"),
      "http://friends.test",
      "m",
    );

    expect(rememberedHandle(both, "http://work.test")).toBe("mira");
    expect(rememberedHandle(both, "http://friends.test")).toBe("m");
    // The question every stale-handle bug started by answering from the wrong place: this
    // machine simply has nothing to say about a hub it has not been to.
    expect(rememberedHandle(both, "http://elsewhere.test")).toBeUndefined();
  });

  it("leaves no temporary file behind for anyone to read", async () => {
    await saveIdentityConfig({ label: "mira", hubUrl: "http://example.test" });
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

describe("recognising a quick tunnel", () => {
  it("knows the hostnames whose name changes when the hub restarts", () => {
    expect(isQuickTunnel("https://webmasters-economic-sailing-engaging.trycloudflare.com")).toBe(true);
    expect(isQuickTunnel("https://webmasters.trycloudflare.com/join")).toBe(true);
  });

  it("leaves every durable address alone", () => {
    expect(isQuickTunnel("http://localhost:8080")).toBe(false);
    expect(isQuickTunnel("https://hub.example.com")).toBe(false);
    // A hub genuinely served from a domain of one's own, which happens to mention cloudflare.
    expect(isQuickTunnel("https://trycloudflare.com.example.com")).toBe(false);
  });

  it("says no rather than throwing when the URL is not one", () => {
    expect(isQuickTunnel("not a url")).toBe(false);
    expect(isQuickTunnel("")).toBe(false);
  });
});
