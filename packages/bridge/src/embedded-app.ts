/**
 * @fileoverview The app build, when it travels inside the binary.
 *
 * Nothing here in a checkout: running from source there is a real `packages/app/dist` on disk
 * and `app-bundle.ts` reads it. `scripts/build.ts` generates a module with this same shape —
 * one `with { type: "file" }` import per built file — and substitutes it at compile time,
 * because Bun can only embed a file it can see a static import for, and Vite's filenames are
 * content-hashed and so unknown until the app has been built.
 */

export const EMBEDDED_APP_FILES: Readonly<Record<string, string>> | undefined = undefined;
