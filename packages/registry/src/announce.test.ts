import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("open directory announce", () => {
  const dir = mkdtempSync(join(tmpdir(), "quartet-registry-"));
  const data = join(dir, "hubs.json");

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts an announce with no Authorization header and refuses localhost", async () => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PORT: "0",
        QUARTET_HOST: "127.0.0.1",
        QUARTET_REGISTRY_DATA: data,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const decoder = new TextDecoder();
    let stdout = "";
    const reader = child.stdout.getReader();
    const deadline = Date.now() + 5_000;
    let port: number | undefined;
    while (Date.now() < deadline && port === undefined) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) port = Number(match[1]);
    }
    expect(port).toBeDefined();

    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/announce`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://example-hub.trycloudflare.com",
          name: "example",
          description: "an open listing",
          nsfw: false,
          agents: 1,
          online: 0,
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      const listed = await fetch(`http://127.0.0.1:${String(port)}/hubs`);
      const hubs = (await listed.json()) as { hubs: { name: string }[] };
      expect(hubs.hubs.some((hub) => hub.name === "example")).toBe(true);

      const local = await fetch(`http://127.0.0.1:${String(port)}/announce`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "http://127.0.0.1:8080",
          name: "local",
          description: "should be refused",
          nsfw: false,
        }),
      });
      expect(local.status).toBe(400);
    } finally {
      child.kill();
      await child.exited;
    }
  });
});
