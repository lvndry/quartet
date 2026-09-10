/**
 * @fileoverview Writing jazz secrets from the local app, without putting them on the wire to
 * the hub or into a snapshot.
 *
 * Jazz refuses secret fields on its HTTP agent API — keys belong in the keyring via
 * `jazz config set`. The agents page needs the same door, so this shells that command.
 */

export type SetSecretResult =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly detail: string };

export type SecretKind = "llm" | "web_search";

/**
 * Store a provider API key where jazz looks for it.
 *
 * - `llm` → `llm.<provider>.api_key`
 * - `web_search` → `web_search.<provider>.api_key`
 *
 * The value is passed as an argv argument (same as `jazz config set <key> <value>`), never
 * logged. Empty provider/key are refused here rather than handed to jazz.
 */
export async function setJazzProviderApiKey(input: {
  readonly kind: SecretKind;
  readonly provider: string;
  readonly key: string;
  readonly jazzCli?: string;
}): Promise<SetSecretResult> {
  const provider = input.provider.trim();
  const key = input.key.trim();
  if (provider.length === 0) return { kind: "failed", detail: "provider is required" };
  if (key.length === 0) return { kind: "failed", detail: "api key is required" };
  if (!/^[a-z][a-z0-9_]*$/i.test(provider)) {
    return { kind: "failed", detail: "provider name looks wrong" };
  }

  const configKey = configKeyFor(input.kind, provider);

  const jazzCli = input.jazzCli ?? "jazz";
  try {
    const child = Bun.spawn({
      cmd: [jazzCli, "config", "set", configKey, key],
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

/** @deprecated Prefer setJazzProviderApiKey — kept name used by earlier call sites. */
export async function setJazzLlmApiKey(input: {
  readonly provider: string;
  readonly key: string;
  readonly jazzCli?: string;
}): Promise<SetSecretResult> {
  return setJazzProviderApiKey({ kind: "llm", ...input });
}

const LLM_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  gemini: "GOOGLE_GENERATIVE_AI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  xai: "XAI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  togetherai: "TOGETHER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

const WEB_SEARCH_KEY_ENV: Record<string, string> = {
  brave: "BRAVE_API_KEY",
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  parallel: "PARALLEL_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  linkup: "LINKUP_API_KEY",
};

function configKeyFor(kind: SecretKind, provider: string): string {
  return kind === "web_search"
    ? `web_search.${provider}.api_key`
    : `llm.${provider}.api_key`;
}

/**
 * Whether a provider API key is already on file (keyring/config or a known env var).
 *
 * Never returns or logs the secret — only a boolean for the agents UI so it can show
 * "on file / replace" instead of an empty box that looks unset.
 */
export async function hasJazzProviderApiKey(input: {
  readonly kind: SecretKind;
  readonly provider: string;
  readonly jazzCli?: string;
}): Promise<boolean> {
  const provider = input.provider.trim().toLowerCase();
  if (provider.length === 0 || !/^[a-z][a-z0-9_]*$/.test(provider)) return false;

  const envName =
    input.kind === "web_search" ? WEB_SEARCH_KEY_ENV[provider] : LLM_KEY_ENV[provider];
  if (envName !== undefined) {
    const fromEnv = process.env[envName];
    if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return true;
  }

  const configKey = configKeyFor(input.kind, provider);
  const jazzCli = input.jazzCli ?? "jazz";
  try {
    const child = Bun.spawn({
      cmd: [jazzCli, "config", "get", configKey],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text().catch(() => "");
    const code = await child.exited.catch(() => 1);
    if (code !== 0) return false;
    const trimmed = stdout.trim();
    if (trimmed.length === 0 || trimmed === "null" || trimmed === "undefined") return false;
    // Discard the value immediately; callers only get the boolean.
    return true;
  } catch {
    return false;
  }
}
