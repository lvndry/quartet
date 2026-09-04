/**
 * OG images are generated per page at build time — 1200×630, the page's own title in Anton
 * over a turn staff.
 *
 * The staff is the mark: four rows because a quartet is four, and each column is one turn.
 * A filled square is an agent that answered, a hollow one is a pass, brass is a human
 * steering. It is the same thing the favicon says in four bars and the same thing the room
 * panel says in words, so a shared link, a browser tab and the page itself are recognisably
 * one object.
 *
 * Seeded by the title, so every page gets its own arrangement and a rebuild produces
 * identical bytes rather than churning the diff.
 *
 * The repo sits opposite the wordmark, on the same baseline: a card is usually seen away from
 * the site it came from, so it has to say where the thing lives.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import { Resvg } from "@resvg/resvg-js";

const WIDTH = 1200;
const HEIGHT = 630;
const MARGIN = 76;

const INK = "#0e1419";
const CREAM = "#ece2d0";
const SLATE = "#7b8896";
const VERMILION = "#e0533a";
const BRASS = "#d7af5f";
const RULE = "#26313b";

// Node resolution rather than cwd- or module-relative paths: this module is bundled at build
// time, so import.meta.url points at the build output, and cwd depends on who invoked the
// build. createRequire survives both.
const requireFromHere = createRequire(import.meta.url);
const FONT_FILES = [
  requireFromHere.resolve("@expo-google-fonts/anton/400Regular/Anton_400Regular.ttf"),
  requireFromHere.resolve("@expo-google-fonts/ibm-plex-mono/500Medium/IBMPlexMono_500Medium.ttf"),
];
for (const fontFile of FONT_FILES) {
  if (!existsSync(fontFile)) {
    // resvg renders missing fonts as nothing at all rather than failing, so a silent blank
    // card would ship. Better to break the build.
    throw new Error(`OG font not found: ${fontFile} — resvg would silently render blank text`);
  }
}

const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const hash = (text: string): number => {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
};

/** Anton is condensed; 24 characters is a safe planning width at this size. */
const wrapTitle = (title: string): string[] => {
  const perLine = 24;
  const words = title.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current !== "" && `${current} ${word}`.length > perLine) {
      lines.push(current);
      current = word;
    } else {
      current = current === "" ? word : `${current} ${word}`;
    }
  }
  if (current !== "") lines.push(current);
  if (lines.length <= 3) return lines;
  const kept = lines.slice(0, 3);
  kept[2] = `${(kept[2] ?? "").slice(0, perLine - 1)}…`;
  return kept;
};

/**
 * The turn staff: four voices down, turns across.
 *
 * Every column holds at most one mark, because a turn belongs to one agent — which is the
 * fact the picture exists to carry. Reading it top to bottom tells you nothing; reading it
 * left to right tells you who answered, who passed and where a person cut in.
 */
const STAFF_ROWS = 4;
const STAFF_ROW_HEIGHT = 12;
const STAFF_ROW_GAP = 8;
const STAFF_HEIGHT = STAFF_ROWS * STAFF_ROW_HEIGHT + (STAFF_ROWS - 1) * STAFF_ROW_GAP;

const renderStaff = (seed: number, top: number): string => {
  const rows = STAFF_ROWS;
  const rowHeight = STAFF_ROW_HEIGHT;
  const rowGap = STAFF_ROW_GAP;
  const markWidth = 16;
  const markGap = 10;
  const columns = Math.floor((WIDTH - MARGIN * 2 + markGap) / (markWidth + markGap));

  const marks: string[] = [];
  for (let column = 0; column < columns; column += 1) {
    const value = ((seed >> (column % 24)) ^ Math.imul(seed, column + 7)) >>> 0;
    const x = MARGIN + column * (markWidth + markGap);

    // A column is silent unless it lands on a turn — the staff should read as sparse
    // conversation rather than a full grid.
    if (value % 100 < 38) continue;

    const row = value % rows;
    const y = top + row * (rowHeight + rowGap);
    const kind = value % 11;

    if (kind === 0) {
      // A human steering, in brass.
      marks.push(
        `<rect x="${x}" y="${y}" width="${markWidth}" height="${rowHeight}" fill="${BRASS}"/>`,
      );
    } else if (kind === 1 || kind === 2) {
      // A pass: recorded as silence, so it is drawn as an outline with nothing inside.
      marks.push(
        `<rect x="${x + 0.5}" y="${y + 0.5}" width="${markWidth - 1}" height="${rowHeight - 1}" fill="none" stroke="${SLATE}" stroke-width="1.5" stroke-dasharray="3 3"/>`,
      );
    } else {
      const opacity = (0.35 + ((value % 500) / 500) * 0.65).toFixed(2);
      marks.push(
        `<rect x="${x}" y="${y}" width="${markWidth}" height="${rowHeight}" fill="${CREAM}" opacity="${opacity}"/>`,
      );
    }
  }

  const lines = Array.from({ length: rows }, (_, row) => {
    const y = top + row * (rowHeight + rowGap) + rowHeight + 5;
    return `<rect x="${MARGIN}" y="${y}" width="${WIDTH - MARGIN * 2}" height="1" fill="${RULE}"/>`;
  });

  return [...lines, ...marks].join("");
};

export function renderOgImage(title: string, subtitle: string): Buffer {
  const seed = hash(title);
  const lines = wrapTitle(title);

  const titleSize = lines.length >= 3 ? 74 : 92;
  const leading = lines.length >= 3 ? 82 : 100;

  // Everything is measured up from the staff rather than down from the top. A title runs to
  // one, two or three lines depending on the page, and laying out downwards let the longest
  // ones push the subtitle straight through the staff.
  const staffTop = HEIGHT - 64 - STAFF_HEIGHT;
  const subtitleBaseline = staffTop - 40;
  const lastTitleBaseline = subtitleBaseline - 46;
  const titleTop = lastTitleBaseline - (lines.length - 1) * leading;

  const titleSvg = lines
    .map(
      (line, index) =>
        `<text x="${MARGIN}" y="${titleTop + index * leading}" font-family="Anton" font-size="${titleSize}" fill="${CREAM}" letter-spacing="1">${escapeXml(line.toUpperCase())}</text>`,
    )
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${INK}"/>
  ${renderStaff(seed, staffTop)}
  <text x="${MARGIN}" y="${MARGIN + 34}" font-family="Anton" font-size="40" fill="${CREAM}" letter-spacing="1">QUARTET<tspan fill="${VERMILION}">.</tspan></text>
  <text x="${WIDTH - MARGIN}" y="${MARGIN + 34}" text-anchor="end" font-family="IBM Plex Mono" font-size="24" fill="${SLATE}" letter-spacing="0.5">github/lvndry/quartet</text>
  ${titleSvg}
  <text x="${MARGIN}" y="${subtitleBaseline}" font-family="IBM Plex Mono" font-size="26" fill="${SLATE}" letter-spacing="0.5">${escapeXml(subtitle)}</text>
</svg>`;

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Anton" },
  });
  return resvg.render().asPng();
}
