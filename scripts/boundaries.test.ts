/**
 * @fileoverview The package boundaries, asserted rather than described.
 *
 * `docs/design/packages.md` says what each package owns and what it must not know. A document
 * cannot fail a build, and every one of these rules was already true and already undocumented
 * once — which is how they erode: not by someone deciding otherwise, but by an import added
 * on a Tuesday that nothing objected to.
 *
 * Deliberately crude. It reads manifests and greps imports rather than building a real module
 * graph, because a check nobody can debug at 2am is a check that gets deleted. If it ever
 * disagrees with the compiler, the compiler is right.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PACKAGES = join(ROOT, "packages");

interface Manifest {
  readonly name: string;
  readonly description?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const packageNames = readdirSync(PACKAGES).filter((entry) =>
  statSync(join(PACKAGES, entry)).isDirectory(),
);

function manifestOf(pkg: string): Manifest {
  return JSON.parse(readFileSync(join(PACKAGES, pkg, "package.json"), "utf8")) as Manifest;
}

function sourceFiles(dir: string): string[] {
  let found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".astro") continue;
      found = found.concat(sourceFiles(path));
    } else if (/\.(ts|tsx|astro)$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** Bare specifiers only — relative paths and node builtins are nobody's dependency. */
function importsIn(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found = new Set<string>();
  // A specifier never contains whitespace, which is what keeps this off the string literals
  // in test files — several of which contain the word `from` a long way from a closing quote.
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s[^;\n]*?\sfrom\s*["']([^"'\s]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\s]+)["']\s*\)/g,
    /(?:^|[\s;}])import\s+["']([^"'\s]+)["']/g,
  ];
  for (const match of patterns.flatMap((pattern) => [...source.matchAll(pattern)])) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    if (specifier.startsWith(".") || specifier.startsWith("node:") || specifier.startsWith("bun:")) {
      continue;
    }
    if (specifier.startsWith("astro:")) continue;
    // `@scope/name/sub` and `name/sub` both belong to the package before the subpath.
    const parts = specifier.split("/");
    found.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier));
  }
  return [...found];
}

describe("every package declares what it imports", () => {
  for (const pkg of packageNames) {
    test(pkg, () => {
      const manifest = manifestOf(pkg);
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ]);
      const src = join(PACKAGES, pkg, "src");
      const files = statSync(src, { throwIfNoEntry: false })?.isDirectory() === true
        ? sourceFiles(src)
        : [];

      const undeclared = new Set<string>();
      for (const file of files) {
        for (const specifier of importsIn(file)) {
          // Types-only tooling packages are the root's business, not a leaf's.
          if (specifier === "bun" || specifier === "typescript") continue;
          if (!declared.has(specifier)) undeclared.add(specifier);
        }
      }
      expect([...undeclared].sort()).toEqual([]);
    });
  }
});

describe("dependencies point toward the things that cannot change casually", () => {
  test("nothing imports an application package", () => {
    const applications = ["@quartet/bridge", "@quartet/hub", "@quartet/app", "@quartet/website"];
    const offenders: string[] = [];
    for (const pkg of packageNames) {
      const manifest = manifestOf(pkg);
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (applications.includes(dependency)) offenders.push(`${pkg} → ${dependency}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the app never imports the hub wire", () => {
    // The single rule this whole exercise exists to hold. `@quartet/protocol/app` is the
    // app's door; the bare specifier is the bridge↔hub wire, which is not the browser's
    // business. See docs/design/packages.md.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(PACKAGES, "app", "src"))) {
      const source = readFileSync(file, "utf8");
      if (/["']@quartet\/protocol["']/.test(source)) offenders.push(file.replace(ROOT, ""));
    }
    expect(offenders).toEqual([]);
  });

  test("the app's door carries no parser", () => {
    // Not style: while these shared a module, zod's whole runtime shipped to the browser to
    // deliver eleven integers. `limits.ts` exists so the ceilings can cross without it.
    const door = readFileSync(join(PACKAGES, "protocol", "src", "snapshot.ts"), "utf8");
    expect(door).not.toMatch(/from ["']zod["']/);
    const limits = readFileSync(join(PACKAGES, "protocol", "src", "limits.ts"), "utf8");
    expect(limits).not.toMatch(/from ["']/);
  });

  test("the website knows nothing about the protocol", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(PACKAGES, "website", "src"))) {
      if (/@quartet\/(protocol|identity|bridge|hub)/.test(readFileSync(file, "utf8"))) {
        offenders.push(file.replace(ROOT, ""));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the paths that only exist as strings", () => {
  test("the bridge serves the app from where the app is actually built", () => {
    // `join(dirname(...), "..", "..", "app", "dist")` is a string, so renaming the package
    // leaves it compiling and pointing nowhere. The only symptom would be every page serving
    // the "no build found" notice, which reads like a missing build rather than a broken path.
    const main = readFileSync(join(PACKAGES, "bridge", "src", "main.ts"), "utf8");
    const match = /appRoot = join\([\s\S]*?"\.\.",\s*"\.\.",\s*"([^"]+)",\s*"([^"]+)"\)/.exec(main);
    expect(match).not.toBeNull();
    const [, pkg, outDir] = match ?? [];
    expect(packageNames).toContain(pkg);

    // And that the package really does build there, rather than the two agreeing by luck.
    const viteConfig = readFileSync(join(PACKAGES, pkg ?? "", "vite.config.ts"), "utf8");
    expect(viteConfig).toContain(`outDir: "${outDir ?? ""}"`);
  });
});

describe("the manifests stay readable on their own", () => {
  test("every package says what it is for", () => {
    const silent = packageNames.filter((pkg) => {
      const description = manifestOf(pkg).description;
      return description === undefined || description.length < 20;
    });
    expect(silent).toEqual([]);
  });

  test("the root manifest stays tooling-only", () => {
    // Runtime dependencies at the root are how a package ends up depending on something it
    // never declared: bun hoists, everything resolves, and the boundary exists only in prose.
    const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Manifest;
    expect(Object.keys(root.dependencies ?? {})).toEqual([]);
  });
});

describe("the theme is the one source of the look", () => {
  test("the favicon has not drifted between the apps", () => {
    // Three copies exist because `public/` cannot import from node_modules in either Vite or
    // Astro. Since they cannot share the file, they at least have to agree about it.
    const canonical = readFileSync(join(PACKAGES, "theme", "favicon.svg"), "utf8");
    for (const app of ["app", "website"]) {
      expect(readFileSync(join(PACKAGES, app, "public", "favicon.svg"), "utf8")).toBe(canonical);
    }
  });

  test("the theme holds tokens, not components", () => {
    // Tokens-only is a decision, recorded in docs/design/packages.md. A selector here means
    // that decision was reversed by accident rather than on purpose.
    const tokens = readFileSync(join(PACKAGES, "theme", "tokens.css"), "utf8");
    const withoutComments = tokens.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...withoutComments.matchAll(/([^{}]+)\{/g)].map((match) => match[1]?.trim());
    expect(rules).toEqual([":root"]);
  });
});
