/**
 * @fileoverview Writing jazz secrets from the local app, without putting them on the wire to
 * the hub or into a snapshot.
 *
 * Jazz refuses `llmApiKeys` on its HTTP agent API — keys belong in the keyring via
 * `jazz config set`. The agents page needs the same door, so this shells that command.
 */

export type SetLlmApiKeyResult =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly detail: string };

/**
 * Store a provider API key where jazz looks for it: `llm.<provider>.api_key` in the keyring.
 *
 * The value is passed as an argv argument (same as `jazz config set <key> <value>`), never
 * logged. Empty provider/key are refused here rather than handed to jazz.
 */
export async function setJazzLlmApiKey(input: {
  readonly provider: string;
  readonly key: string;
  readonly jazzCli?: string;
}): Promise<SetLlmApiKeyResult> {
  const provider = input.provider.trim();
  const key = input.key.trim();
  if (provider.length === 0) return { kind: "failed", detail: "provider is required" };
  if (key.length === 0) return { kind: "failed", detail: "api key is required" };
  if (!/^[a-z][a-z0-9_]*$/i.test(provider)) {
    return { kind: "failed", detail: "provider name looks wrong" };
  }

  const jazzCli = input.jazzCli ?? "jazz";
  try {
    const child = Bun.spawn({
      cmd: [jazzCli, "config", "set", `llm.${provider}.api_key`, key],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text().catch(() => "");
    const code = await child.exited.catch(() => 1);
    if (code !== 0) {
      const detail = stderr.trim().split("\n").at(-1) ?? `jazz config set exited ${String(code)}`;
      return { kind: "failed", detail };
    }
    return { kind: "ok" };
  } catch (error) {
    return {
      kind: "failed",
      detail: error instanceof Error ? error.message : "could not run jazz config set",
    };
  }
}
