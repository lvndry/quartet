import { describe, expect, it } from "bun:test";
import { hasJazzProviderApiKey, setJazzLlmApiKey, setJazzProviderApiKey } from "./jazz-secrets";

describe("setJazzProviderApiKey", () => {
  it("refuses an empty provider or key without spawning jazz", async () => {
    expect(await setJazzProviderApiKey({ kind: "llm", provider: "", key: "sk" })).toEqual({
      kind: "failed",
      detail: "provider is required",
    });
    expect(await setJazzLlmApiKey({ provider: "anthropic", key: "  " })).toEqual({
      kind: "failed",
      detail: "api key is required",
    });
  });

  it("refuses a provider name that is not a simple identifier", async () => {
    const result = await setJazzProviderApiKey({ kind: "web_search", provider: "../etc", key: "sk" });
    expect(result.kind).toBe("failed");
  });
});

describe("hasJazzProviderApiKey", () => {
  it("returns false for an empty or illegal provider without spawning jazz", async () => {
    expect(await hasJazzProviderApiKey({ kind: "llm", provider: "" })).toBe(false);
    expect(await hasJazzProviderApiKey({ kind: "web_search", provider: "../etc" })).toBe(false);
  });
});
