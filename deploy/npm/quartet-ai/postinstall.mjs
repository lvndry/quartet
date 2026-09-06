#!/usr/bin/env node
/**
 * Replaces bin/quartet — a placeholder in the published tarball — with the real platform
 * binary. The binary never ships inside `quartet-ai` itself; it lives in a per-platform
 * optionalDependency (quartet-ai-darwin-arm64 and friends) that npm/pnpm/bun has already
 * resolved down to just this machine's platform, so this only has to find it and copy it
 * into place.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const targetBinary = path.join(here, "bin", "quartet");

function isMusl() {
  if (os.platform() !== "linux") return false;
  try {
    if (fs.existsSync("/etc/alpine-release")) return true;
  } catch {
    // Ignore filesystem probes a sandboxed host may block.
  }
  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.toLowerCase().includes("musl");
  } catch {
    return false;
  }
}

function candidatePackageNames() {
  const platform = os.platform();
  const arch = os.arch();
  const base = `quartet-ai-${platform}-${arch}`;
  if (platform === "linux") return isMusl() ? [`${base}-musl`, base] : [base, `${base}-musl`];
  return [base];
}

function resolveBinaryFrom(packageName) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const binaryPath = path.join(path.dirname(packageJsonPath), "bin", "quartet");
  if (!fs.existsSync(binaryPath)) throw new Error(`Binary not found at ${binaryPath}`);
  return binaryPath;
}

function installBinary(source) {
  fs.mkdirSync(path.dirname(targetBinary), { recursive: true });
  if (fs.existsSync(targetBinary)) fs.unlinkSync(targetBinary);
  try {
    fs.linkSync(source, targetBinary);
  } catch {
    fs.copyFileSync(source, targetBinary);
  }
  fs.chmodSync(targetBinary, 0o755);
}

function verifyBinary() {
  const result = childProcess.spawnSync(targetBinary, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  return result.status === 0;
}

function main() {
  const candidates = candidatePackageNames();
  for (const packageName of candidates) {
    try {
      installBinary(resolveBinaryFrom(packageName));
      // Verified rather than assumed: the glibc build resolves fine on a musl host and then
      // dies on its first run, which is a much worse place to find out.
      if (verifyBinary()) return;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    `Could not find a quartet binary for this platform (${os.platform()}-${os.arch()}). ` +
      `Your package manager may not have installed one of: ${candidates.join(", ")}. ` +
      `Reinstall without --ignore-scripts, or install one of those packages directly.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
