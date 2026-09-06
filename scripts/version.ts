/**
 * @fileoverview What a build calls itself, and where that answer comes from.
 *
 * The tag, not a file. A version committed to `package.json` has to be bumped in a commit
 * before the tag that releases it, which is a second place to say the same number and so a
 * place for the two to disagree — silently, because nothing downstream can tell that
 * `v0.2.0` was meant when `0.1.0` was published. There is one source now and nothing to keep
 * in step with it.
 *
 * A checkout has no tag to read, so it describes itself instead: `0.1.0-3-g47c3f6e` says
 * three commits past v0.1.0, which is more use than a stale number from a manifest.
 */

/** Everything the answer depends on, passed in so the precedence can be tested. */
export interface VersionSources {
  /** `--version <v>`, straight off argv. What the release workflow passes. */
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `git describe`, or `undefined` where there is no git and no tags. */
  readonly describe: () => string | undefined;
}

/** A release version: semver, optionally with a prerelease or build tail. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Where the answer came from, which is the part that decides whether it may be published.
 *
 * Shape is not enough to tell a release from a checkout. `git describe` yields
 * `0.1.0-3-gabc1234`, and the placeholder is `0.0.0-dev` — both are valid semver, and npm
 * would take either without complaint. What separates them is that nobody chose them.
 */
export type VersionSource = "flag" | "tag" | "git" | "none";

export interface ResolvedVersion {
  readonly version: string;
  readonly source: VersionSource;
}

/** Tags are written `v0.2.0` and versions are not. One place strips it. */
function withoutLeadingV(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

/**
 * The version this build should carry.
 *
 * `--version` first because it is the explicit answer; `TAG_NAME` next because the release
 * workflow sets it for every job and so a step that forgets the flag still agrees with the
 * one that passed it; `git describe` for a checkout; and a placeholder when even git cannot
 * say, which is a tarball somebody downloaded rather than cloned.
 */
export function resolveVersion(sources: VersionSources): ResolvedVersion {
  const flag = sources.args.indexOf("--version");
  const explicit = flag === -1 ? undefined : sources.args[flag + 1];
  if (explicit !== undefined && !explicit.startsWith("--")) {
    return { version: withoutLeadingV(explicit), source: "flag" };
  }

  const tag = sources.env["TAG_NAME"];
  if (tag !== undefined && tag.length > 0) return { version: withoutLeadingV(tag), source: "tag" };

  const described = sources.describe();
  if (described !== undefined && described.length > 0) {
    return { version: withoutLeadingV(described), source: "git" };
  }

  return { version: "0.0.0-dev", source: "none" };
}

/**
 * Refuses to stamp a package with a version nobody chose.
 *
 * This is what makes the tag load-bearing rather than decorative, and it asks about
 * provenance before shape, because shape cannot tell the two apart: `git describe` produces
 * `0.1.0-3-gabc1234` and the fallback is `0.0.0-dev`, both of which npm would publish
 * happily. A build that was not told its version has not been released, whatever it managed
 * to work out about itself.
 */
export function assertPublishable(resolved: ResolvedVersion): void {
  if (resolved.source === "git" || resolved.source === "none") {
    throw new Error(
      `Refusing to publish ${resolved.version}, which this build worked out for itself ` +
        `(${resolved.source === "git" ? "from git describe" : "no tag, no git"}). ` +
        `A release takes its version from the tag: tag it (e.g. v0.2.0), or pass --version.`,
    );
  }
  if (!SEMVER.test(resolved.version)) {
    throw new Error(
      `"${resolved.version}" is not a version npm will take. Tags are written like v0.2.0.`,
    );
  }
}

/** `git describe`, or `undefined` when git cannot answer — no repository, or no tags yet. */
export function describeFromGit(): string | undefined {
  const result = Bun.spawnSync(["git", "describe", "--tags", "--always", "--dirty"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  const described = result.stdout.toString().trim();
  return described.length > 0 ? described : undefined;
}

/** The version for this process, from the real world. */
export function currentVersion(args: readonly string[] = process.argv.slice(2)): ResolvedVersion {
  return resolveVersion({ args, env: process.env, describe: describeFromGit });
}
