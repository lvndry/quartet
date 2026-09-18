/**
 * @fileoverview Durable opaque session ids issued by external runtimes.
 *
 * Namespaced by a fingerprint of the runtime command and working directory: changing the
 * program behind an identity must never hand one agent another agent's conversation id.
 */

import { join } from "node:path";
import { writeJsonAtomically } from "../atomic";
import { getDataDirectory } from "../paths";

const FILE_MODE = 0o600;

interface StoredSessions {
  readonly version: 1;
  readonly runtimes: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

function empty(): StoredSessions {
  return { version: 1, runtimes: {} };
}

export function runtimeFingerprint(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(JSON.stringify([input.command, input.args, input.cwd]));
  return hash.digest("hex").slice(0, 24);
}

export class RuntimeSessionStore {
  private loaded: Promise<StoredSessions> | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly namespace: string,
    private readonly path = join(getDataDirectory(), "runtime-sessions.json"),
  ) {}

  async get(conversationId: string): Promise<string | undefined> {
    return (await this.read()).runtimes[this.namespace]?.[conversationId];
  }

  async set(conversationId: string, sessionId: string): Promise<void> {
    this.writes = this.writes.then(async () => {
      const held = await this.read();
      const next: StoredSessions = {
        version: 1,
        runtimes: {
          ...held.runtimes,
          [this.namespace]: {
            ...held.runtimes[this.namespace],
            [conversationId]: sessionId,
          },
        },
      };
      await writeJsonAtomically(this.path, next, FILE_MODE);
      this.loaded = Promise.resolve(next);
    });
    await this.writes;
  }

  private read(): Promise<StoredSessions> {
    if (this.loaded !== undefined) return this.loaded;
    this.loaded = this.readFile();
    return this.loaded;
  }

  private async readFile(): Promise<StoredSessions> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return empty();
    const parsed = (await file.json().catch(() => undefined)) as Partial<StoredSessions> | undefined;
    if (parsed?.version !== 1 || typeof parsed.runtimes !== "object" || parsed.runtimes === null) {
      return empty();
    }
    return { version: 1, runtimes: parsed.runtimes };
  }
}
