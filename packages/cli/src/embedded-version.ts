/**
 * @fileoverview What a compiled build calls itself.
 *
 * Nothing here in a checkout, where `version.ts` asks git instead. `scripts/build.ts`
 * generates a module with this shape and substitutes it at compile time, the same way it
 * does for the app build — a released binary has no git repository to ask and no manifest
 * beside it, so the number has to be baked in while there is still something that knows it.
 */

export const EMBEDDED_VERSION: string | undefined = undefined;
