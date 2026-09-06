import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflaredPath, startTunnel } from "./index";

/**
 * A stand-in `cloudflared` binary, pointed to via `CLOUDFLARED_BIN` — the same variable a
 * machine that already has the binary would set, and the one escape hatch `cloudflaredPath`
 * honours. Real tests never shell out to the real binary or its download step, which would
 * need network access.
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
  delete process.env["CLOUDFLARED_BIN"];
  delete process.env["QUARTET_HOME"];
});

function use(path: string): void {
  process.env["CLOUDFLARED_BIN"] = path;
}

describe("where the binary lives", () => {
  /**
   * The property a compiled binary depends on. `cloudflared`'s own default is beside its
   * `node_modules` copy, which inside a standalone `quartet` is a read-only path in the
   * embedded filesystem: the download fails there every time, silently, and the tunnel never
   * comes up. Asserted rather than trusted, because the failure looks like a network problem.
   */
  it("is somewhere writable, never inside the bundle that imported it", () => {
    delete process.env["CLOUDFLARED_BIN"];
    delete process.env["QUARTET_HOME"];
    expect(cloudflaredPath()).toBe(join(homedir(), ".quartet", "bin", "cloudflared"));
    expect(cloudflaredPath()).not.toContain("node_modules");
  });

  it("follows the data directory when one is set", () => {
    process.env["QUARTET_HOME"] = "/somewhere/else";
    expect(cloudflaredPath()).toBe(join("/somewhere/else", "bin", "cloudflared"));
  });

  it("yields to a binary this machine already has", () => {
    process.env["CLOUDFLARED_BIN"] = "/usr/local/bin/cloudflared";
    expect(cloudflaredPath()).toBe("/usr/local/bin/cloudflared");
  });
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

    const result = await startTunnel(8080, { readyTimeoutMs: 200 });
    expect(result.kind).toBe("timed-out");
  });

  /**
   * The failure this was written for: a quick tunnel dying is the end of its hostname, and
   * for a while the only account of it was a bridge on another machine reporting, minutes
   * later, that a name had stopped resolving. A tunnel that stops has to say so where the
   * person who handed out the URL can see it.
   */
  it("says so when the tunnel exits after coming up", async () => {
    const fake = fakeBinary(
      "#!/bin/sh\n" +
        'echo "|  https://fake-words-5678.trycloudflare.com  |" >&2\n' +
        "exit 3\n",
    );
    cleanups.push(fake.cleanup);
    use(fake.path);

    const notices: string[] = [];
    const result = await startTunnel(8080, { onNotice: (notice) => notices.push(notice) });
    expect(result.kind).toBe("ok");

    await Bun.sleep(200);
    expect(notices.some((notice) => notice.includes("the tunnel exited (code 3)"))).toBe(true);
  });
});
