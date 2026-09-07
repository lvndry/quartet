/**
 * The precedence, and the refusal.
 *
 * Written because the failure this replaces was silent: a `v0.2.0` tag with `0.1.0` still in
 * a manifest published `0.1.0`, and nothing anywhere said so. There is one source now, and
 * `assertPublishable` is what stops a build that has no tag from inventing one.
 */
import { describe, expect, test } from "bun:test";
import { assertPublishable, resolveVersion } from "./version";

function sources(options: {
  args?: readonly string[];
  env?: Record<string, string | undefined>;
  described?: string | undefined;
}) {
  return {
    args: options.args ?? [],
    env: options.env ?? {},
    describe: () => options.described,
  };
}

describe("where a version comes from", () => {
  test("--version wins, because it is somebody saying so", () => {
    expect(
      resolveVersion(sources({ args: ["--version", "1.2.3"], env: { TAG_NAME: "v9.9.9" }, described: "0.0.1" })),
    ).toEqual({ version: "1.2.3", source: "flag" });
  });

  test("a tag is a tag whether or not it is spelt with its v", () => {
    expect(resolveVersion(sources({ args: ["--version", "v1.2.3"] })).version).toBe("1.2.3");
    expect(resolveVersion(sources({ env: { TAG_NAME: "v1.2.3" } })).version).toBe("1.2.3");
  });

  test("TAG_NAME carries a release to a step that forgot the flag", () => {
    expect(resolveVersion(sources({ env: { TAG_NAME: "v0.2.0" }, described: "0.1.0-3-gabc" }))).toEqual({
      version: "0.2.0",
      source: "tag",
    });
  });

  test("a checkout describes itself rather than reading a stale number", () => {
    expect(resolveVersion(sources({ described: "0.1.0-3-gabc1234" }))).toEqual({
      version: "0.1.0-3-gabc1234",
      source: "git",
    });
  });

  test("and says so plainly when even git cannot answer", () => {
    expect(resolveVersion(sources({}))).toEqual({ version: "0.0.0-dev", source: "none" });
  });

  test("a --version with no value after it is not a value", () => {
    // `--version --target bun-linux-x64` is a real thing to mistype, and taking "--target"
    // as the version would stamp the npm packages with it.
    expect(resolveVersion(sources({ args: ["--version", "--target"], env: { TAG_NAME: "v0.2.0" } })).version).toBe(
      "0.2.0",
    );
  });
});

describe("what may be published", () => {
  test("accepts a version somebody chose", () => {
    for (const version of ["0.1.0", "1.2.3", "0.2.0-rc.1", "1.0.0+build.5"]) {
      expect(() => { assertPublishable({ version, source: "tag" }); }).not.toThrow();
      expect(() => { assertPublishable({ version, source: "flag" }); }).not.toThrow();
    }
  });

  test("refuses what a build worked out for itself, however well-formed", () => {
    // The reason this asks about provenance and not shape. Both of these are valid semver
    // and npm would publish either — the objection is that nobody chose them.
    expect(() => { assertPublishable({ version: "0.1.0-3-gabc1234", source: "git" }); }).toThrow(
      /worked out for itself/,
    );
    expect(() => { assertPublishable({ version: "0.0.0-dev", source: "none" }); }).toThrow(/worked out for itself/);
  });

  test("refuses a tag that is not a version", () => {
    for (const version of ["0.2", "release-2", "v0.2.0"]) {
      expect(() => { assertPublishable({ version, source: "tag" }); }).toThrow(/not a version npm will take/);
    }
  });
});
