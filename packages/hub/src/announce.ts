/**
 * Tell the public hub directory this hub exists.
 *
 * Quartet's production registry is open: anyone with a public hub URL may list.
 * A bearer token is only sent when somebody self-hosts a locked registry and sets one.
 */

import { prompt } from "./ask";

export interface AnnouncePayload {
  readonly name: string;
  readonly description: string;
  readonly nsfw: boolean;
  readonly agents: number;
  readonly online: number;
}

/** Quartet's public directory. Override with `--registry-url` / `$QUARTET_REGISTRY_URL` only for self-hosted registries. */
export const DEFAULT_REGISTRY_URL = "https://registry-production-7cb4.up.railway.app";

const INTERVAL_MS = 5 * 60_000;

export interface AnnounceConfig {
  readonly registryUrl: string;
  /** Optional — only for a self-hosted registry that still checks a bearer token. */
  readonly token?: string;
  readonly publicOrigin: string;
}

/**
 * Intent gathered from flags / env / TTY before the tunnel (if any) has a URL.
 * `publicOrigin` may be filled later from `--tunnel`.
 */
export interface AnnounceIntent {
  readonly registryUrl: string;
  readonly token?: string;
  readonly publicOrigin?: string;
  /** True when `--tunnel` should supply the public URL once it comes up. */
  readonly awaitTunnel: boolean;
}

export function originFromUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
}

export function publicOriginFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = originFromUrl(env["QUARTET_PUBLIC_URL"]);
  if (fromEnv !== undefined) return fromEnv;
  const railway = env["RAILWAY_PUBLIC_DOMAIN"]?.trim();
  if (railway !== undefined && railway.length > 0) {
    const host = railway.replace(/^https?:\/\//, "");
    return `https://${host}`;
  }
  return undefined;
}

export function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0:0:0:0:0:0:0:1"
    );
  } catch {
    return true;
  }
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function registryUrlFrom(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    trimOrUndefined(flag)?.replace(/\/$/, "") ??
    trimOrUndefined(env["QUARTET_REGISTRY_URL"])?.replace(/\/$/, "") ??
    DEFAULT_REGISTRY_URL
  );
}

export function registryTokenFrom(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return trimOrUndefined(flag) ?? trimOrUndefined(env["QUARTET_HUB_REGISTRY_TOKEN"]);
}

/**
 * Whether listing was opted into without asking — flags or the env Railway hubs already set.
 *
 * `$QUARTET_REGISTRY_URL` remains an opt-in signal so existing unattended deploys keep announcing
 * after the directory went open (they no longer need a token).
 */
export function announceOptedIn(
  announceFlag: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (announceFlag) return true;
  if (env["QUARTET_ANNOUNCE"] === "1") return true;
  const registry = trimOrUndefined(env["QUARTET_REGISTRY_URL"]);
  return registry !== undefined;
}

export type ResolveAnnounceOptions = {
  readonly announceFlag: boolean;
  readonly registryUrlFlag?: string | undefined;
  readonly registryTokenFlag?: string | undefined;
  readonly publicUrlFlag?: string | undefined;
  readonly wantsTunnel: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly ask?: typeof prompt;
};

/**
 * Decide whether to list, and gather registry + public URL pieces.
 *
 * Never asks for a registry URL (baked-in default) or a token. On TTY, asks only whether to
 * list and — when neither tunnel nor env/flag already has one — for a public URL.
 */
export async function resolveAnnounceIntent(
  options: ResolveAnnounceOptions,
): Promise<AnnounceIntent | undefined> {
  const env = options.env ?? process.env;
  const ask = options.ask ?? prompt;

  let want = announceOptedIn(options.announceFlag, env);
  if (!want) {
    const answered = await ask("  list this hub on the public directory? [y/N] ");
    if (answered === undefined) return undefined;
    const t = answered.toLowerCase();
    if (t === "y" || t === "yes") want = true;
    else return undefined;
  }

  const registryUrl = registryUrlFrom(options.registryUrlFlag, env);
  const token = registryTokenFrom(options.registryTokenFlag, env);
  let publicOrigin =
    originFromUrl(options.publicUrlFlag) ?? publicOriginFromEnv(env);

  if (publicOrigin === undefined && !options.wantsTunnel) {
    const answered = await ask("  public URL for this hub (https://…)? ");
    if (answered === undefined) {
      console.warn(
        "  ! listing skipped — need a public URL (pass --public-url, set QUARTET_PUBLIC_URL, or use --tunnel)",
      );
      return undefined;
    }
    publicOrigin = originFromUrl(answered);
    if (publicOrigin === undefined) {
      console.warn("  ! listing skipped — that did not look like a URL");
      return undefined;
    }
  }

  if (publicOrigin !== undefined && isLocalOrigin(publicOrigin) && !options.wantsTunnel) {
    console.warn(
      "  ! listing skipped — a localhost URL cannot be listed; use --tunnel or a public --public-url",
    );
    return undefined;
  }

  return {
    registryUrl,
    ...(token !== undefined ? { token } : {}),
    ...(publicOrigin !== undefined ? { publicOrigin } : {}),
    awaitTunnel: options.wantsTunnel && (publicOrigin === undefined || isLocalOrigin(publicOrigin)),
  };
}

/**
 * Finish an intent once a tunnel URL (or other late public URL) is known.
 * Returns undefined when there is still nothing public to announce.
 */
export function finalizeAnnounceConfig(
  intent: AnnounceIntent,
  tunnelUrl?: string,
): AnnounceConfig | undefined {
  const fromTunnel = originFromUrl(tunnelUrl);
  const publicOrigin =
    intent.publicOrigin !== undefined && !isLocalOrigin(intent.publicOrigin)
      ? intent.publicOrigin
      : fromTunnel;

  if (publicOrigin === undefined || isLocalOrigin(publicOrigin)) {
    console.warn(
      "  ! listing skipped — no public URL (localhost-only hubs cannot announce; use --tunnel or --public-url)",
    );
    return undefined;
  }

  return {
    registryUrl: intent.registryUrl,
    ...(intent.token !== undefined ? { token: intent.token } : {}),
    publicOrigin,
  };
}

export function startAnnouncing(
  getPayload: () => AnnouncePayload,
  config: AnnounceConfig,
): void {
  const registry = config.registryUrl.replace(/\/$/, "");
  const origin = config.publicOrigin;
  const token = config.token;

  const tick = async (): Promise<void> => {
    const payload = getPayload();
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (token !== undefined && token.length > 0) {
        headers["authorization"] = `Bearer ${token}`;
      }
      const response = await fetch(`${registry}/announce`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url: origin, ...payload }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.warn(
          `  ! registry announce failed (${String(response.status)})${detail ? `: ${detail.slice(0, 120)}` : ""}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  ! registry announce error: ${message}`);
    }
  };

  console.log(`  announcing to ${registry} as ${origin}`);
  void tick();
  setInterval(() => void tick(), INTERVAL_MS);
}
