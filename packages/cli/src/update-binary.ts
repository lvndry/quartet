/**
 * @fileoverview In-place updates for a curl-installed `quartet` binary.
 *
 * Same job as jazz's `update-binary`: pick this machine's release asset, verify SHA-256,
 * replace the running executable. npm installs are out of scope until publish works.
 */

import { createHash } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

const RELEASE_DOWNLOAD_BASE = "https://github.com/lvndry/quartet/releases/download";
const CHECKSUM_FILE = "SHA256SUMS";
const REPO = "lvndry/quartet";

function isMuslLinux(): boolean {
  return (
    existsSync("/lib/ld-musl-x86_64.so.1") ||
    existsSync("/lib/ld-musl-aarch64.so.1") ||
    existsSync("/etc/alpine-release")
  );
}

/** Release asset basename matching this machine, or `undefined` if we publish none. */
export function resolveReleaseAssetName(): string | undefined {
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (architecture === undefined) return undefined;

  if (process.platform === "darwin") return `quartet-darwin-${architecture}`;
  if (process.platform === "linux") {
    return `quartet-linux-${architecture}${isMuslLinux() ? "-musl" : ""}`;
  }
  return undefined;
}

export function findExpectedChecksum(checksumFile: string, assetName: string): string | undefined {
  for (const line of checksumFile.split("\n")) {
    const [digest, name] = line.trim().split(/\s+/);
    if (digest && name && name.replace(/^\*/, "") === assetName) return digest;
  }
  return undefined;
}

export function compareSemver(left: string, right: string): number {
  const parts = (value: string): number[] =>
    value
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

export async function fetchLatestReleaseTag(): Promise<string | undefined> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "quartet" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { tag_name?: unknown };
  return typeof body.tag_name === "string" && body.tag_name.length > 0
    ? body.tag_name.replace(/^v/, "")
    : undefined;
}

function replaceRunningBinary(executablePath: string, replacement: Uint8Array): void {
  const stagingPath = join(
    dirname(executablePath),
    `.${basename(executablePath)}.update-${String(process.pid)}`,
  );
  try {
    writeFileSync(stagingPath, replacement, { mode: 0o755 });
    renameSync(stagingPath, executablePath);
  } catch (cause) {
    rmSync(stagingPath, { force: true });
    throw cause;
  }
}

/**
 * Download `version` (no leading v) and install it over `process.execPath`.
 */
export async function installBinaryUpdate(version: string): Promise<void> {
  const assetName = resolveReleaseAssetName();
  if (assetName === undefined) {
    throw new Error(
      `Quartet does not publish a binary for ${process.platform}/${process.arch}. ` +
        `Re-run the installer, or install from npm when that path works.`,
    );
  }

  const releaseBase = `${RELEASE_DOWNLOAD_BASE}/v${version}`;
  const [archiveResponse, checksumResponse] = await Promise.all([
    fetch(`${releaseBase}/${assetName}.gz`, { redirect: "follow", signal: AbortSignal.timeout(120_000) }),
    fetch(`${releaseBase}/${CHECKSUM_FILE}`, { redirect: "follow", signal: AbortSignal.timeout(15_000) }),
  ]);
  if (!archiveResponse.ok) {
    throw new Error(`Downloading ${assetName}.gz returned ${String(archiveResponse.status)}`);
  }
  if (!checksumResponse.ok) {
    throw new Error(`Downloading ${CHECKSUM_FILE} returned ${String(checksumResponse.status)}`);
  }

  const archiveBytes = new Uint8Array(await archiveResponse.arrayBuffer());
  const expected = findExpectedChecksum(await checksumResponse.text(), `${assetName}.gz`);
  if (expected === undefined) {
    throw new Error(`Release ${version} has no checksum for ${assetName}.gz — refusing to install.`);
  }
  const actual = createHash("sha256").update(archiveBytes).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${assetName}.gz — refusing to install.\n` +
        `  expected ${expected}\n  actual   ${actual}`,
    );
  }

  const binary = gunzipSync(archiveBytes);
  replaceRunningBinary(process.execPath, binary);
}
