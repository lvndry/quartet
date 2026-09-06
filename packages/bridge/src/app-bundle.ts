/**
 * @fileoverview The built app, from wherever this copy of quartet keeps it.
 *
 * Two places, one interface. From a checkout it is `packages/app/dist` on disk, which is what
 * `bun run app:build` writes and what the dev loop rebuilds. From a published binary it is a
 * table of paths inside the embedded filesystem, because a released `quartet` is one file and
 * there is no `dist` next to it.
 *
 * Content types come from the requested URL rather than the file being served. In a binary
 * the embedded name is Bun's to choose, and a stylesheet delivered as `text/plain` is a page
 * that renders unstyled with nothing in the console to say why.
 */

import { dirname, join } from "node:path";
import { EMBEDDED_APP_FILES } from "./embedded-app";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml; charset=utf-8",
  ttf: "font/ttf",
  wasm: "application/wasm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
};

/** The built app, addressed the way a browser asks for it. */
export interface AppBundle {
  /** What is at this URL path, or `undefined` when the build has nothing there. */
  readonly response: (urlPath: string) => Promise<Response | undefined>;
  /** The shell, for the client-side routes that have no file of their own. */
  readonly shell: () => Response;
}

function respond(file: Bun.BunFile, urlPath: string): Response {
  const dot = urlPath.lastIndexOf(".");
  const type = dot === -1 ? undefined : CONTENT_TYPES[urlPath.slice(dot + 1).toLowerCase()];
  return new Response(file, type === undefined ? undefined : { headers: { "content-type": type } });
}

/**
 * The built app, or `undefined` when this checkout has not built one.
 *
 * A binary always has one — it was compiled in — so the absent case only happens from source,
 * where `connect` says so rather than serving a blank page.
 */
export async function loadAppBundle(): Promise<AppBundle | undefined> {
  return EMBEDDED_APP_FILES === undefined
    ? await appBundleFromDirectory(builtAppDirectory())
    : embedded(EMBEDDED_APP_FILES);
}

/**
 * Where `bun run app:build` leaves its output, as seen from this file.
 *
 * A string, so renaming the package leaves this compiling and pointing nowhere — the only
 * symptom being every page serving the "no build found" notice, which reads like a missing
 * build rather than a broken path. `scripts/boundaries.test.ts` holds it to the real one.
 */
function builtAppDirectory(): string {
  return join(dirname(Bun.fileURLToPath(import.meta.url)), "..", "..", "app", "dist");
}

function embedded(files: Readonly<Record<string, string>>): AppBundle | undefined {
  const shell = files["/index.html"];
  if (shell === undefined) return undefined;
  return {
    response: (urlPath) => Promise.resolve(lookup(files, urlPath)),
    shell: () => respond(Bun.file(shell), "/index.html"),
  };
}

function lookup(files: Readonly<Record<string, string>>, urlPath: string): Response | undefined {
  const path = files[urlPath];
  return path === undefined ? undefined : respond(Bun.file(path), urlPath);
}

/** A build sitting in a directory. Exported so the serving path can be tested against one. */
export async function appBundleFromDirectory(root: string): Promise<AppBundle | undefined> {
  const shell = Bun.file(join(root, "index.html"));
  if (!(await shell.exists())) return undefined;
  return {
    response: async (urlPath) => {
      // The URL parser has already collapsed `..` out of a pathname, and an encoded one stays
      // encoded rather than becoming a separator — but this joins attacker-supplied text onto
      // a real directory, and that is not a place to reason from what a parser happens to do.
      if (urlPath.includes("..")) return undefined;
      const file = Bun.file(join(root, urlPath));
      return (await file.exists()) ? respond(file, urlPath) : undefined;
    },
    shell: () => respond(shell, "/index.html"),
  };
}
