import { describe, expect, it } from "bun:test";
import { setJazzLlmApiKey } from "./jazz-secrets";

describe("setJazzLlmApiKey", () => {
  it("refuses an empty provider or key without spawning jazz", async () => {
    expect(await setJazzLlmApiKey({ provider: "", key: "sk" })).toEqual({
      kind: "failed",
      detail: "provider is required",
    });
    expect(await setJazzLlmApiKey({ provider: "anthropic", key: "  " })).toEqual({
      kind: "failed",
      detail: "api key is required",
    });
  });

  it("refuses a provider name that is not a simple identifier", async () => {
    const result = await setJazzLlmApiKey({ provider: "../etc", key: "sk" });
    expect(result.kind).toBe("failed");
  });
});
