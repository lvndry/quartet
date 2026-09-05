/**
 * @fileoverview Why a hub is not answering — not merely that it isn't.
 *
 * A quartet hub is meant to be something one person runs with one command, and the one
 * command that makes it reachable from outside hands out a name that lasts as long as the
 * process does. That is a fine trade, but it produces a failure the old boolean check could
 * not describe: the URL on file is not wrong, and the hub is not down, the *name* is gone and
 * no amount of waiting will bring that one back.
 *
 * Telling that apart from a hub that is merely restarting is what decides the advice. One
 * says wait, the other says go and fetch the new URL, and giving the wrong one wastes an
 * afternoon. DNS is what separates them: cloudflare withdraws a quick tunnel's hostname when
 * the tunnel stops, so a name that no longer resolves is a name that is not coming back.
 */

import { isQuickTunnel } from "./config";

export type HubCheck =
  /** Answering, and it is a quartet hub. */
  | { kind: "ok" }
  /**
   * The hostname does not resolve.
   *
   * For a quick tunnel this is as final as it sounds. For any other host it is more likely a
   * typo or a DNS problem, which is why the advice is written from the URL, not from here.
   */
  | { kind: "gone" }
  /** Resolves, but nothing answered in time — a hub that is down, or a path that swallows. */
  | { kind: "silent" }
  /** Resolves, and something actively refused the connection. Nothing is listening. */
  | { kind: "refused" }
  /** Something answered, but it is not a quartet hub — a parked page, or the wrong port. */
  | { kind: "not-a-hub" };

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Ask a hub whether it is there, and get back why it is not.
 *
 * A 200 alone is not enough: a mistyped domain can land on a parked page that answers every
 * path with its own HTML. The exact `/health` body is what tells the two apart.
 */
export async function checkHub(hubUrl: string): Promise<HubCheck> {
  try {
    const response = await fetch(new URL("/health", hubUrl), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return { kind: "not-a-hub" };
    const body = (await response.json().catch(() => undefined)) as { ok?: boolean } | undefined;
    return body?.ok === true ? { kind: "ok" } : { kind: "not-a-hub" };
  } catch (error) {
    return { kind: classify(error) };
  }
}

/**
 * Read the runtime's failure back as one of the cases above.
 *
 * Matched on the code where there is one and on the message where there is not, because a
 * DNS failure is the single most useful thing this module can recognise and it would be a
 * poor trade to miss it over an unstable error shape.
 */
function classify(error: unknown): Exclude<HubCheck["kind"], "ok" | "not-a-hub"> {
  const { code, message, name } = error as { code?: unknown; message?: unknown; name?: unknown };
  const text = `${String(code ?? "")} ${String(message ?? "")} ${String(name ?? "")}`;
  if (text.includes("ENOTFOUND") || text.includes("EAI_AGAIN") || text.includes("getaddrinfo")) {
    return "gone";
  }
  if (text.includes("ConnectionRefused") || text.includes("ECONNREFUSED")) return "refused";
  return "silent";
}

/** The short verdict, for the line that names the hub. */
export function describeHub(check: HubCheck): string {
  switch (check.kind) {
    case "ok":
      return "reachable";
    case "gone":
      return "gone, that name no longer resolves";
    case "refused":
      return "not running, nothing is listening there";
    case "not-a-hub":
      return "answering, but not like a hub";
    default:
      return "not answering";
  }
}

/**
 * What to do about it, on the assumption `describeHub` already said what happened.
 *
 * Returned as lines rather than printed so the same words can go to a terminal, to the app's
 * error banner, or into a test that checks we say the useful thing. One line each: this is
 * read by somebody who wants their hub back, not an explanation of cloudflare.
 */
export function explainHub(hubUrl: string, check: HubCheck): string[] {
  if (check.kind === "ok") return [];

  if (check.kind === "gone" && isQuickTunnel(hubUrl)) {
    return ["Restart the hub and reconnect with --hub <the URL it prints>."];
  }

  switch (check.kind) {
    case "gone":
      return ["Check the hostname for typos, and whatever serves its DNS."];
    case "refused":
      return ["Start it with `bun run hub` — add `--tunnel` to reach it from outside."];
    case "not-a-hub":
      return ["A parked domain or the wrong port will both do this."];
    default:
      return ["It may be down or still starting. Worth trying again in a moment."];
  }
}

/**
 * One line for the app's error banner, where even three is too many.
 *
 * Says what to do and not only what happened: this string is often the only thing a person
 * looking at a stalled app ever reads.
 */
export function summariseHub(hubUrl: string, check: HubCheck): string {
  switch (check.kind) {
    case "ok":
      return "";
    case "gone":
      return isQuickTunnel(hubUrl)
        ? `${hubUrl} no longer resolves — reconnect with --hub <the URL the hub prints>.`
        : `${hubUrl} does not resolve.`;
    case "refused":
      return `nothing is listening at ${hubUrl} — the hub is not running.`;
    case "not-a-hub":
      return `${hubUrl} answers, but not like a quartet hub.`;
    default:
      return `${hubUrl} is not answering — retrying.`;
  }
}
