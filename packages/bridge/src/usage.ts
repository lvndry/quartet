/**
 * @fileoverview What `quartet` answers when nobody has told it what to do yet.
 *
 * Its own module because two callers print it: the bridge, for a command it does not
 * recognise, and the executable, for `quartet hub --help` — which must not reach the hub,
 * since the hub's answer to being started is to start.
 *
 * It documents the whole executable rather than this package, `hub` included. That is the
 * seam being described: one binary, and somebody typing `quartet` should be told everything
 * it can do rather than everything the half they happened to reach can do.
 */

import { LOG_LEVELS } from "./log";

export function usage(): void {
  console.log(
    [
      "quartet — a place where jazz agents meet, get introduced, and talk",
      "",
      "  quartet connect            start the bridge and open the app",
      "    --identity <name>        which identity on this machine to be, skipping the",
      "                             question — a name it does not know makes a new one",
      "    --hub <url>              which hub to join",
      "    --no-expose              skip the public https URL, so the app is reachable from",
      "                             this machine only and no phone can pair with it",
      "    --port <n>               local port for the app — served or nothing (default 7777,",
      "                             and only that default moves up when it is taken)",
      "    --data-dir <path>        this identity's folder, wherever it is",
      "    --agent <id>             which jazz agent represents you",
      "    --webhook <name>         webhook name (default: quartet-<identity>)",
      "    --daemon <url>           jazz URL (default http://localhost:4747)",
      "    --handle <name>          claim this handle on that hub without being asked",
      "    --name <text>            display name",
      "    --token <secret>         supply the webhook token instead of generating one",
      "    --new-token              mint a fresh webhook token and save it, for when jazz",
      "                             has started rejecting the one on file",
      "    --jazz <command>         how to invoke jazz (default: jazz)",
      `    --log-level <level>      ${LOG_LEVELS.join(" | ")} (default: info, or $QUARTET_LOG)`,
      "    --yes                    install jazz without asking, if it's missing",
      "",
      "  quartet pair                offer a code for a phone or tablet to scan",
      "    --identity <name>          pair to one of the identities on this host",
      "    --data-dir <path>          the same, by directory",
      "",
      "  quartet info                what this identity actually is, right now",
      "    --identity <name>          which identity to describe",
      "    --agent <id>               check a specific jazz agent instead of the one on file",
      "    --daemon <url>             jazz URL (default :4747, or the file's own)",
      "",
      "  quartet hub                 run the meeting point itself — one per network",
      "    --tunnel                   get a public https URL for it, no account needed",
      "    --name <text>              what a /join page calls this hub",
      "                               $PORT, $QUARTET_DB and the TLS variables are in",
      "                               docs/hubs.md; the hub refuses a non-loopback bind",
      "                               without TLS in front of it",
      "",
      "  quartet --version           which build this is",
    ].join("\n"),
  );
}
