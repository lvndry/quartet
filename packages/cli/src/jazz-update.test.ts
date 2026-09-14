import { afterEach, describe, expect, it } from "bun:test";
import { resolveJazzCli } from "./jazz-update";

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
});

describe("resolveJazzCli", () => {
  it("falls back to the jazz on PATH", () => {
    process.argv = ["bun", "quartet", "connect"];
    expect(resolveJazzCli()).toBe("jazz");
  });

  it("honours --jazz, the same flag the bridge takes", () => {
    process.argv = ["bun", "quartet", "connect", "--jazz", "/opt/jazz/bin/jazz"];
    expect(resolveJazzCli()).toBe("/opt/jazz/bin/jazz");
  });

  it("ignores a --jazz with the next flag behind it", () => {
    process.argv = ["bun", "quartet", "connect", "--jazz", "--handle", "ada"];
    expect(resolveJazzCli()).toBe("jazz");
  });
});
