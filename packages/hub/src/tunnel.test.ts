import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTunnelUrl, startTunnel } from "./tunnel";

/** A stand-in `cloudflared` that prints its own script rather than shelling out to Cloudflare. */
function fakeBinary(script: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "quartet-tunnel-"));
  const path = join(dir, "cloudflared");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("parseTunnelUrl", () => {
  it("pulls the URL out of cloudflared's boxed banner", () => {
    const banner = [
      "2024-01-01T00:00:00Z INF +----------------------------------------------+",
      "2024-01-01T00:00:00Z INF |  Your quick Tunnel has been created!          |",
      "2024-01-01T00:00:00Z INF |  https://fond-otter-4821.trycloudflare.com    |",
      "2024-01-01T00:00:00Z INF +----------------------------------------------+",
    ].join("\n");
    expect(parseTunnelUrl(banner)).toBe("https://fond-otter-4821.trycloudflare.com");
  });

  it("finds nothing in plain log lines", () => {
    expect(parseTunnelUrl("2024-01-01T00:00:00Z INF Starting tunnel\n")).toBeUndefined();
  });
});

describe("startTunnel", () => {
  it("reports a missing binary rather than throwing", async () => {
    const result = await startTunnel(8080, "definitely-not-a-real-binary-xyz");
    expect(result.kind).toBe("missing-binary");
  });

  it("extracts the URL once the process reports it, and leaves it running", async () => {
    const fake = fakeBinary(
      "#!/bin/sh\n" +
        'echo "starting..." >&2\n' +
        'echo "|  https://fake-words-1234.trycloudflare.com  |" >&2\n' +
        "sleep 30\n",
    );
    cleanups.push(fake.cleanup);

    const result = await startTunnel(8080, fake.path);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.url).toBe("https://fake-words-1234.trycloudflare.com");
      result.process.kill();
    }
  });

  it("gives up once the deadline passes with no URL", async () => {
    const fake = fakeBinary("#!/bin/sh\nsleep 30\n");
    cleanups.push(fake.cleanup);

    const result = await startTunnel(8080, fake.path, 200);
    expect(result.kind).toBe("timed-out");
  });
});
