/**
 * The one distinction that matters: an empty answer is a person, no answer is nobody.
 *
 * Written after `connect` accepted a `curl | bash` install on a CI runner. The prompt asked
 * "Install it? [Y/n]", stdin was closed, the read came back "", "" does not start with "n",
 * and quartet installed jazz onto a machine nobody was sitting at.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { prompt } from "./ask";

const wasTTY = process.stdin.isTTY;

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
});

function attached(isTTY: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
}

describe("asking with nobody there", () => {
  test("answers undefined rather than an empty string", async () => {
    attached(false);
    expect(await prompt("Install it? [Y/n] ")).toBeUndefined();
  });

  test("is not the same answer as pressing enter", async () => {
    // The whole point. `"" .startsWith("n")` is false, so a caller that treats these alike
    // reads silence as consent — which is exactly what happened.
    attached(false);
    expect(await prompt("Install it? [Y/n] ")).not.toBe("");
  });

  test("prints no question, because nothing can answer it", async () => {
    attached(false);
    const written: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await prompt("Where is your daemon? ");
    } finally {
      process.stdout.write = realWrite;
    }
    expect(written).toEqual([]);
  });
});
