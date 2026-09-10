/**
 * @fileoverview Hub URLs as people type them, cleaned into what connect should use.
 *
 * Railway (and most hosted hubs) only speak HTTPS. Pasting `http://…` used to store a
 * different string than the working `https://…` URL — so a handle claimed on one never
 * matched the other, and the person was asked to claim again on a "new" hub.
 */

/**
 * Prefer https for any non-loopback hub, and accept a bare host as https://host.
 *
 * Loopback stays http: local hubs and quick tunnels during development are not TLS.
 */
export function normalizeHubUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;

  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return trimmed;
  }

  const host = parsed.hostname;
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!loopback && parsed.protocol === "http:") {
    parsed.protocol = "https:";
  }

  // Trailing slash is noise for identity caches keyed by the URL string.
  return parsed.toString().replace(/\/$/, "");
}
