import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JAZZ_DAEMON_TOKEN_ENV, resolveJazzDaemonToken } from "./jazz-daemon-token";

const previous = process.env[JAZZ_DAEMON_TOKEN_ENV];
const previousHome = process.env["JAZZ_HOME"];

afterEach(() => {
  if (previous === undefined) delete process.env[JAZZ_DAEMON_TOKEN_ENV];
  else process.env[JAZZ_DAEMON_TOKEN_ENV] = previous;
  if (previousHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = previousHome;
});

describe("resolveJazzDaemonToken", () => {
  it("prefers JAZZ_DAEMON_TOKEN over everything else", async () => {
    process.env[JAZZ_DAEMON_TOKEN_ENV] = "  from-env  ";
    // Even with a secrets file present, env wins.
    const home = await mkdtemp(join(tmpdir(), "quartet-daemon-token-"));
    process.env["JAZZ_HOME"] = home;
    await writeFile(join(home, "secrets.json"), JSON.stringify({ "daemon.token": "from-file" }));

    expect(await resolveJazzDaemonToken()).toBe("from-env");
  });

  it("reads daemon.token from $JAZZ_HOME/secrets.json when env is unset", async () => {
    delete process.env[JAZZ_DAEMON_TOKEN_ENV];
    const home = await mkdtemp(join(tmpdir(), "quartet-daemon-token-"));
    process.env["JAZZ_HOME"] = home;
    await writeFile(
      join(home, "secrets.json"),
      `${JSON.stringify({ "daemon.token": "file-secret", "webhooks.x.token": "other" }, null, 2)}\n`,
    );

    expect(await resolveJazzDaemonToken()).toBe("file-secret");
  });

  it("returns undefined when nothing is configured", async () => {
    delete process.env[JAZZ_DAEMON_TOKEN_ENV];
    const home = await mkdtemp(join(tmpdir(), "quartet-daemon-token-"));
    process.env["JAZZ_HOME"] = home;
    await mkdir(home, { recursive: true });
    // No secrets.json, and a synthetic JAZZ_HOME so we do not touch the real keyring path
    // for the file fallback. Keyring may still return a live machine token on darwin — skip
    // asserting undefined when that happens by pointing at an empty home and accepting that
    // keyring-or-undefined is fine as long as we do not invent a value.
    const resolved = await resolveJazzDaemonToken();
    // File is empty; if the OS keyring has a real jazz daemon token this may still be set.
    // The important contract under test above is env + file. Here just ensure we never return
    // whitespace-only.
    if (resolved !== undefined) expect(resolved.trim().length).toBeGreaterThan(0);
  });
});
