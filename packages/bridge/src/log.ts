/**
 * @fileoverview What the bridge prints while it runs.
 *
 * The bridge is a long-lived process somebody leaves in a terminal, so the log is the only
 * window into what it is doing between messages. Levels exist so that window can be a
 * one-line-per-event summary by default and a full trace when something is wrong.
 *
 * Set with `--log-level` or `QUARTET_LOG`.
 */

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const COLOR: Record<LogLevel, string> = {
  error: "[31m",
  warn: "[33m",
  info: "[36m",
  debug: "[90m",
};
const DIM = "[90m";
const RESET = "[0m";

/** Colour is skipped when stdout is redirected, so a captured log stays plain text. */
const useColor = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;

function paint(text: string, color: string): string {
  return useColor ? `${color}${text}${RESET}` : text;
}

export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  return LOG_LEVELS.find((level) => level === value?.trim().toLowerCase());
}

// Read here so every entry point honours it, not only the one that parses flags.
let threshold: LogLevel = parseLogLevel(process.env["QUARTET_LOG"]) ?? "info";

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function currentLogLevel(): LogLevel {
  return threshold;
}

function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

/**
 * One event.
 *
 * `scope` is the part of the bridge talking — `hub`, `daemon`, `turn` — so a log can be
 * followed by reading one column. `fields` are appended as `key=value`, which greps well and
 * keeps the message itself short enough to scan.
 */
function emit(
  level: LogLevel,
  scope: string,
  message: string,
  fields?: Record<string, string | number | undefined>,
): void {
  if (RANK[level] > RANK[threshold]) return;

  const pairs = Object.entries(fields ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => paint(`${key}=${String(value)}`, DIM))
    .join(" ");

  const line = [
    paint(clock(), DIM),
    paint(level.padEnd(5), COLOR[level]),
    paint(scope.padEnd(7), DIM),
    message,
    pairs,
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export interface Logger {
  error: (message: string, fields?: Record<string, string | number | undefined>) => void;
  warn: (message: string, fields?: Record<string, string | number | undefined>) => void;
  info: (message: string, fields?: Record<string, string | number | undefined>) => void;
  debug: (message: string, fields?: Record<string, string | number | undefined>) => void;
}

export function logger(scope: string): Logger {
  return {
    error: (message, fields) => emit("error", scope, message, fields),
    warn: (message, fields) => emit("warn", scope, message, fields),
    info: (message, fields) => emit("info", scope, message, fields),
    debug: (message, fields) => emit("debug", scope, message, fields),
  };
}
