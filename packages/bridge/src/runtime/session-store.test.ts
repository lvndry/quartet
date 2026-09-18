import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSessionStore, runtimeFingerprint } from "./session-store";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "quartet-runtime-sessions-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("runtime session store", () => {
  it("survives another store instance", async () => {
    const path = join(directory, "sessions.json");
    await new RuntimeSessionStore("runtime-a", path).set("room-1", "session-1");

    expect(await new RuntimeSessionStore("runtime-a", path).get("room-1")).toBe("session-1");
  });

  it("does not share sessions between runtime bindings", async () => {
    const path = join(directory, "sessions.json");
    await new RuntimeSessionStore("runtime-a", path).set("room-1", "session-1");

    expect(await new RuntimeSessionStore("runtime-b", path).get("room-1")).toBeUndefined();
  });

  it("fingerprints argv boundaries and working directory", () => {
    const first = runtimeFingerprint({ command: "agent", args: ["a", "b"], cwd: "/one" });
    expect(runtimeFingerprint({ command: "agent", args: ["a b"], cwd: "/one" })).not.toBe(first);
    expect(runtimeFingerprint({ command: "agent", args: ["a", "b"], cwd: "/two" })).not.toBe(first);
  });
});
