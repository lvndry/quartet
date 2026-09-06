/**
 * @fileoverview What this build calls itself.
 *
 * Read from the root manifest through a JSON import rather than the filesystem, so the number
 * is fixed when the binary is compiled instead of looked for next to an executable that ships
 * alone. One version for the whole workspace: the bridge and the hub are two halves of one
 * release, and a machine reporting different numbers for them would be describing a state
 * that cannot happen.
 */

import manifest from "../../../package.json" with { type: "json" };

export const VERSION: string = manifest.version;
