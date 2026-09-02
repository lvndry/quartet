import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { use } from "cloudflared";
import { startTunnel } from "./tunnel";

/**
 * A stand-in `cloudflared` binary, pointed to via the library's own `use()` override — the
 * same mechanism it exposes for anyone running a self-hosted mirror. Real tests never shell
 * out to the real binary or its download step, which would need network access.
 */
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

describe("startTunnel", () => {
  it("extracts the URL once cloudflared reports it, and leaves the tunnel running", async () => {
    const fake = fakeBinary(
      "#!/bin/sh\n" +
        'echo "starting..." >&2\n' +
        'echo "|  https://fake-words-1234.trycloudflare.com  |" >&2\n' +
        "sleep 30\n",
    );
    cleanups.push(fake.cleanup);
    use(fake.path);

    const result = await startTunnel(8080);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.url).toBe("https://fake-words-1234.trycloudflare.com");
      result.stop();
    }
  });

  it("gives up once the deadline passes with no URL", async () => {
    const fake = fakeBinary("#!/bin/sh\nsleep 30\n");
    cleanups.push(fake.cleanup);
    use(fake.path);

    const result = await startTunnel(8080, 200);
    expect(result.kind).toBe("timed-out");
  });
});
