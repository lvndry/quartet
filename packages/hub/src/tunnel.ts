/**
 * @fileoverview A public URL for this hub, for the "run it for a friend" case.
 *
 * The `cloudflared` npm package rather than an assumed binary: Cloudflare has no pure-JS
 * client, so "no install step" means fetching the Go binary ourselves. Quick tunnels rather
 * than ngrok because they need no account and proxy WebSockets without an interstitial, both
 * of which matter for `/socket`.
 */

import { bin, install, Tunnel } from "cloudflared";

const READY_TIMEOUT_MS = 30_000;

export type TunnelResult =
  | { readonly kind: "ok"; readonly url: string; readonly stop: () => void }
  | { readonly kind: "download-failed"; readonly detail: string }
  | { readonly kind: "timed-out" }
  | { readonly kind: "failed"; readonly detail: string };

type Attempt = TunnelResult | { readonly kind: "missing-binary" };

/**
 * Starts a quick tunnel to `http://localhost:<port>` and waits for its public URL.
 *
 * Tries to run first rather than probing the filesystem: the OS says precisely when a binary
 * is missing, on the spawn we had to make anyway. Only then does it fetch the binary and
 * retry once.
 */
export async function startTunnel(port: number, readyTimeoutMs = READY_TIMEOUT_MS): Promise<TunnelResult> {
  const first = await attempt(port, readyTimeoutMs);
  if (first.kind !== "missing-binary") return first;

  try {
    await install(bin);
  } catch (error) {
    return { kind: "download-failed", detail: error instanceof Error ? error.message : String(error) };
  }

  const second = await attempt(port, readyTimeoutMs);
  return second.kind === "missing-binary"
    ? { kind: "failed", detail: "cloudflared was downloaded but still would not run" }
    : second;
}

function attempt(port: number, readyTimeoutMs: number): Promise<Attempt> {
  const child = Tunnel.quick(`http://localhost:${String(port)}`);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.stop();
      resolve({ kind: "timed-out" });
    }, readyTimeoutMs);

    child.once("url", (url) => {
      clearTimeout(timeout);
      resolve({ kind: "ok", url, stop: child.stop });
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      resolve(error.code === "ENOENT" ? { kind: "missing-binary" } : { kind: "failed", detail: error.message });
    });
  });
}
