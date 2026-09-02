/**
 * @fileoverview A public URL for this hub, for the "run it for a friend" case.
 *
 * Shells out to `cloudflared`'s quick tunnels rather than embedding a tunnel client or
 * reaching for ngrok: quick tunnels need no account and no token, which is the whole point of
 * a flag meant to remove ceremony, not add a signup step in front of it. They also proxy
 * WebSocket traffic cleanly and show no browser interstitial — both of which matter here,
 * since the hub's real protocol runs over a `/socket` upgrade, not just plain JSON requests.
 */

const READY_TIMEOUT_MS = 20_000;

export type TunnelResult =
  | { readonly kind: "ok"; readonly url: string; readonly process: Bun.Subprocess }
  | { readonly kind: "missing-binary" }
  | { readonly kind: "timed-out" }
  | { readonly kind: "failed"; readonly detail: string };

/** The URL cloudflared prints once a quick tunnel is live, pulled out of its own banner. */
export function parseTunnelUrl(output: string): string | undefined {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(output)?.[0];
}

/**
 * Starts a quick tunnel to `http://localhost:<port>` and waits for its public URL.
 *
 * cloudflared writes its banner — URL included — to stderr, not stdout, so that is the
 * stream read here. The process is left running on success; the caller owns killing it on
 * shutdown. `binary` is overridable so tests can point this at a stand-in rather than
 * requiring `cloudflared` on the machine running them.
 */
export async function startTunnel(
  port: number,
  binary = "cloudflared",
  readyTimeoutMs = READY_TIMEOUT_MS,
): Promise<TunnelResult> {
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn(
      [binary, "tunnel", "--url", `http://localhost:${String(port)}`, "--no-autoupdate"],
      { stdout: "ignore", stderr: "pipe" },
    );
  } catch {
    return { kind: "missing-binary" };
  }

  const stderr = child.stderr;
  if (!(stderr instanceof ReadableStream)) {
    child.kill();
    return { kind: "failed", detail: "cloudflared's stderr was not readable" };
  }
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const timeout = setTimeout(() => void reader.cancel(), readyTimeoutMs);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const url = parseTunnelUrl(buffered);
      if (url !== undefined) {
        // The tunnel keeps writing to stderr as it runs. Nobody is reading it after this
        // point unless something drains it, and an unread pipe eventually applies backpressure
        // that could stall cloudflared itself — so draining continues quietly in the background.
        void drainForever(reader);
        return { kind: "ok", url, process: child };
      }
    }
  } catch (error) {
    child.kill();
    return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }

  child.kill();
  return { kind: "timed-out" };
}

async function drainForever(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  } catch {
    // The process exited or the pipe broke; nothing left to drain.
  }
}
