/**
 * @fileoverview A public URL for a loopback server — the hub, so somebody can be invited to it;
 * the bridge, so a paired phone can reach the app.
 *
 * The `cloudflared` npm package rather than an assumed binary: Cloudflare has no pure-JS
 * client, so "no install step" means fetching the Go binary ourselves. Quick tunnels rather
 * than ngrok because they need no account and proxy WebSockets without an interstitial, both
 * of which matter for `/socket`.
 *
 * Where that binary lands is quartet's answer rather than the package's. Its own default sits
 * next to its `node_modules` copy, which inside a compiled `quartet` is a read-only path in
 * the embedded filesystem — the download would fail there every time, and a tunnel would
 * quietly never come up.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { install, Tunnel, use } from "cloudflared";

const READY_TIMEOUT_MS = 30_000;

/**
 * Where this machine keeps its cloudflared.
 *
 * The same `~/.quartet` the bridge writes identities into, resolved here rather than imported
 * so the tunnel stays a leaf: the hub uses it too, and the hub has no business depending on
 * the bridge's paths. `CLOUDFLARED_BIN` is the package's own escape hatch and is honoured, so
 * a machine that already has the binary somewhere can say so.
 *
 * Exported because the answer is the whole point: the package's own default sits beside its
 * `node_modules` copy, and a compiled `quartet` has none — the download would fail into a
 * read-only path every time and a tunnel would simply never come up.
 */
export function cloudflaredPath(): string {
  const override = process.env["CLOUDFLARED_BIN"];
  if (override !== undefined && override.length > 0) return override;
  const configured = process.env["QUARTET_HOME"];
  const root =
    configured !== undefined && configured.length > 0
      ? configured.startsWith("~")
        ? join(homedir(), configured.slice(1))
        : configured
      : join(homedir(), ".quartet");
  return join(root, "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
}

/**
 * What the caller wants out of `startTunnel` beyond the URL.
 *
 * `onNotice` exists because a quick tunnel is the least durable thing in the path and, until
 * it was wired up, the loudest thing it could do was nothing: `cloudflared` losing an edge
 * connection, or exiting and taking the hostname with it, reached nobody. The bridge on the
 * far side then spent its reconnect backoff blaming a hub that was still running.
 *
 * A callback rather than a logger: this package is a leaf, and the hub and the bridge do not
 * print the same way.
 */
export interface TunnelWatch {
  readonly readyTimeoutMs?: number;
  readonly onNotice?: (notice: string) => void;
}

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
export async function startTunnel(port: number, watch: TunnelWatch = {}): Promise<TunnelResult> {
  const binary = cloudflaredPath();
  use(binary);

  const first = await attempt(port, watch);
  if (first.kind !== "missing-binary") return first;

  try {
    await mkdir(dirname(binary), { recursive: true });
    await install(binary);
  } catch (error) {
    return { kind: "download-failed", detail: error instanceof Error ? error.message : String(error) };
  }

  const second = await attempt(port, watch);
  return second.kind === "missing-binary"
    ? { kind: "failed", detail: "cloudflared was downloaded but still would not run" }
    : second;
}

function attempt(port: number, watch: TunnelWatch): Promise<Attempt> {
  const child = Tunnel.quick(`http://localhost:${String(port)}`);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.stop();
      resolve({ kind: "timed-out" });
    }, watch.readyTimeoutMs ?? READY_TIMEOUT_MS);

    child.once("url", (url) => {
      clearTimeout(timeout);
      report(child, watch.onNotice);
      resolve({ kind: "ok", url, stop: child.stop });
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      resolve(error.code === "ENOENT" ? { kind: "missing-binary" } : { kind: "failed", detail: error.message });
    });
  });
}

/**
 * Say out loud what `cloudflared` says about itself, once the tunnel is up.
 *
 * Only after the URL: everything before it is startup noise the caller already gets a verdict
 * for. Afterwards it is the only account of a tunnel that stops working, and a quick tunnel
 * stopping is not recoverable — the hostname is leased to this process, so `exit` means every
 * invite already handed out is now a name that will not resolve.
 *
 * The `error` listener is not optional. `once` covers the spawn and then unsubscribes, and an
 * EventEmitter with no listener for `error` throws it: an error after startup would take the
 * whole hub down rather than the tunnel it was about.
 */
function report(child: Tunnel, onNotice: ((notice: string) => void) | undefined): void {
  let dropped = false;

  child.on("error", (error: Error) => {
    onNotice?.(`the tunnel reported an error: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    const how = signal !== null ? `signal ${signal}` : `code ${String(code ?? "?")}`;
    onNotice?.(
      `the tunnel exited (${how}). Its URL is gone for good — quick-tunnel hostnames belong ` +
        "to the process that opened them. Restart to get a new one.",
    );
  });

  child.on("disconnected", () => {
    dropped = true;
    onNotice?.("lost an edge connection to cloudflare — sockets through it will have dropped");
  });

  child.on("connected", () => {
    // Not on the way up, where there are four of these and none of them are news.
    if (!dropped) return;
    dropped = false;
    onNotice?.("edge connection re-established");
  });
}
