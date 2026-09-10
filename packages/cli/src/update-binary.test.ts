import { describe, expect, it } from "bun:test";
import { compareSemver, findExpectedChecksum, resolveReleaseAssetName } from "./update-binary";

describe("compareSemver", () => {
  it("orders plain patch bumps", () => {
    expect(compareSemver("0.0.6", "0.0.5")).toBe(1);
    expect(compareSemver("0.0.5", "0.0.6")).toBe(-1);
    expect(compareSemver("0.0.6", "0.0.6")).toBe(0);
  });

  it("tolerates a leading v", () => {
    expect(compareSemver("v0.0.6", "0.0.5")).toBe(1);
  });
});

describe("findExpectedChecksum", () => {
  it("matches sha256sum lines with optional binary marker", () => {
    const file = "abc123  quartet-darwin-arm64.gz\ndef456 *quartet-linux-x64.gz\n";
    expect(findExpectedChecksum(file, "quartet-darwin-arm64.gz")).toBe("abc123");
    expect(findExpectedChecksum(file, "quartet-linux-x64.gz")).toBe("def456");
  });
});

describe("resolveReleaseAssetName", () => {
  it("returns a name on this platform or undefined", () => {
    const name = resolveReleaseAssetName();
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(name?.startsWith("quartet-")).toBe(true);
    }
  });
});
