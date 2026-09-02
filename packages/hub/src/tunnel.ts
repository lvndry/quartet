/**
 * @fileoverview A public URL for this hub, for the "run it for a friend" case.
 *
 * Built on the `cloudflared` npm package rather than assuming the binary is already on the
 * machine: Cloudflare has no pure-JS tunnel client, only the Go binary, so "no install step"
 * means downloading that binary ourselves the first time it's needed rather than asking
 * somebody to `brew install` it first. Quick tunnels specifically — not ngrok — because they
 * need no account and no authtoken, and they proxy WebSocket traffic without the browser
 * interstitial ngrok's free tier shows, both of which matter for the hub's `/socket` upgrade.
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
 * Tries to run first rather than checking the filesystem beforehand — the OS already tells
 * us precisely when a binary is missing, on the same spawn we needed to make anyway. Only on
 * that failure does this fetch the binary — a one-time cost of a few dozen megabytes, the
 * same download `brew install cloudflared` would make, just triggered by us instead of asked
 * of the person running the hub — and try once more.
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
