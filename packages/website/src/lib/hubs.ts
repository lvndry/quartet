/**
 * Client helpers for the public hub directory.
 *
 * The list is not hardcoded — hubs announce themselves to the registry. The site only
 * needs PUBLIC_HUB_REGISTRY_URL (origin of the registry service).
 */

export interface HubRecord {
  readonly url: string;
  readonly name: string;
  readonly description: string;
  readonly nsfw: boolean;
  readonly agents: number;
  readonly online: number;
  readonly seenAt: string;
}

/** Registry origin. Empty means the page shows a setup hint instead of a list. */
export function registryOrigin(): string {
  const raw = import.meta.env.PUBLIC_HUB_REGISTRY_URL as string | undefined;
  if (raw === undefined || raw.trim().length === 0) return "";
  return raw.trim().replace(/\/$/, "");
}

export async function fetchHubs(origin: string): Promise<HubRecord[]> {
  const response = await fetch(`${origin}/hubs`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`registry ${String(response.status)}`);
  const body = (await response.json()) as { hubs?: HubRecord[] };
  return Array.isArray(body.hubs) ? body.hubs : [];
}
