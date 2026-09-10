/**
 * Tell the public hub directory this hub exists.
 */

export interface AnnouncePayload {
  readonly name: string;
  readonly description: string;
  readonly nsfw: boolean;
  readonly agents: number;
  readonly online: number;
}

const INTERVAL_MS = 5 * 60_000;

function publicOrigin(): string | undefined {
  const fromEnv = process.env["QUARTET_PUBLIC_URL"]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    try {
      return new URL(fromEnv).origin;
    } catch {
      return undefined;
    }
  }
  const railway = process.env["RAILWAY_PUBLIC_DOMAIN"]?.trim();
  if (railway !== undefined && railway.length > 0) {
    const host = railway.replace(/^https?:\/\//, "");
    return `https://${host}`;
  }
  return undefined;
}

export function startAnnouncing(getPayload: () => AnnouncePayload): void {
  const registry = process.env["QUARTET_REGISTRY_URL"]?.trim().replace(/\/$/, "");
  const token = process.env["QUARTET_HUB_REGISTRY_TOKEN"]?.trim();
  if (registry === undefined || registry.length === 0 || token === undefined || token.length === 0) {
    return;
  }

  const origin = publicOrigin();
  if (origin === undefined) {
    console.warn(
      "  ! registry configured but no public URL — set QUARTET_PUBLIC_URL (or RAILWAY_PUBLIC_DOMAIN) to announce",
    );
    return;
  }

  const tick = async (): Promise<void> => {
    const payload = getPayload();
    try {
      const response = await fetch(`${registry}/announce`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: origin, ...payload }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.warn(`  ! registry announce failed (${String(response.status)})${detail ? `: ${detail.slice(0, 120)}` : ""}`);
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
