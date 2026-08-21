import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";
import xtermHeadless from "@xterm/headless";
import type { HudActivity, HudState } from "../src/ui-hud-model.js";

const { Terminal } = xtermHeadless;

const SCREENS = ["activity", "activity-empty", "workspace", "devices", "help"] as const;
type PreviewScreen = typeof SCREENS[number];

const PREVIEW_NOW = Date.UTC(2026, 7, 20, 14, 0, 0);
const DEFAULT_COLUMNS = 90;
const DEFAULT_ROWS = 24;
const MIN_COLUMNS = 24;
const MAX_COLUMNS = 200;
const MIN_ROWS = 8;
const MAX_ROWS = 80;
const CELL_WIDTH = 10;
const CELL_HEIGHT = 22;
const FONT_SIZE = 16;
const PADDING = 20;
const FOREGROUND = "#f4f1fb";
const BACKGROUND = "#100e16";
const ANSI_16 = [
  "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
  "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
] as const;

interface PreviewOptions {
  screen: PreviewScreen;
  columns: number;
  rows: number;
  clean: boolean;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const previewDirectory = path.join(repositoryRoot, ".hud-preview");
const previewImage = path.join(previewDirectory, "current.png");
const require = createRequire(import.meta.url);
const fontRoot = path.dirname(require.resolve("dejavu-fonts-ttf/package.json"));
const fontFiles = [
  "DejaVuSansMono.ttf",
  "DejaVuSansMono-Bold.ttf",
  "DejaVuSansMono-Oblique.ttf",
  "DejaVuSansMono-BoldOblique.ttf",
].map((file) => path.join(fontRoot, "ttf", file));

function usage(): string {
  return [
    "Usage: npm run cli:hud-preview -- [options]",
    "",
    `  --screen <${SCREENS.join("|")}>`,
    `  --width <${MIN_COLUMNS}-${MAX_COLUMNS}>`,
    `  --height <${MIN_ROWS}-${MAX_ROWS}>`,
    "  --clean",
    "  --help",
  ].join("\n");
}

function boundedInteger(value: string | undefined, label: string, min: number, max: number): number {
  if (!value || !/^\d+$/.test(value)) throw new UsageError(`${label} must be an integer from ${min} through ${max}.`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new UsageError(`${label} must be from ${min} through ${max}.`);
  return parsed;
}

function parseArgs(args: string[]): PreviewOptions | "help" {
  const options: PreviewOptions = {
    screen: "activity",
    columns: DEFAULT_COLUMNS,
    rows: DEFAULT_ROWS,
    clean: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--clean") {
      options.clean = true;
    } else if (argument === "--screen") {
      const value = args[++index];
      if (!value || !SCREENS.includes(value as PreviewScreen)) {
        throw new UsageError(`--screen must be one of: ${SCREENS.join(", ")}.`);
      }
      options.screen = value as PreviewScreen;
    } else if (argument === "--width") {
      options.columns = boundedInteger(args[++index], "--width", MIN_COLUMNS, MAX_COLUMNS);
    } else if (argument === "--height") {
      options.rows = boundedInteger(args[++index], "--height", MIN_ROWS, MAX_ROWS);
    } else {
      throw new UsageError(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function previewActivities(now: number): HudActivity[] {
  return [
    { tool: "list_files", summary: { target: 'path "packages/cli/src"', details: ["recursive", "limit 100"], truncation: "middle" }, requestId: "preview-list", state: "returned", updatedAt: now - 240_000 },
    { tool: "read_file", summary: { target: 'path "packages/cli/src/ui-hud.tsx"', details: [], truncation: "middle" }, requestId: "preview-read", state: "returned", updatedAt: now - 55_000 },
    { tool: "search_text", summary: { target: 'query "activityPageCapacity" in path "packages/cli/src"', details: ["extensions .ts, .tsx"], truncation: "middle" }, requestId: "preview-search", state: "returned", updatedAt: now - 31_000 },
    { tool: "read_file_range", summary: { target: 'path "packages/cli/src/ui-hud-model.test.ts"', details: ["lines 700–820"], truncation: "middle" }, requestId: "preview-range", state: "returned", updatedAt: now - 22_000 },
    { tool: "edit_file", summary: { target: 'path "packages/cli/src/ui-hud.tsx"', details: ["2 edits", "guarded"], truncation: "middle" }, requestId: "preview-edit", state: "returned", updatedAt: now - 12_000 },
    { tool: "run_command", summary: { target: 'argv ["npm", "run", "check"]', details: ["timeout 120000 ms"], truncation: "middle" }, requestId: "preview-failed", state: "failed", updatedAt: now - 9_000 },
    { tool: "view_image", summary: { target: 'path ".hud-preview/current.png"', details: [], truncation: "middle" }, requestId: "preview-image", state: "returned", updatedAt: now - 5_000 },
    { tool: "run_command", summary: { target: 'argv ["npm", "run", "cli:hud-preview", "--", "--screen", "activity"]', details: [], truncation: "middle" }, requestId: "preview-running", state: "working", updatedAt: now },
  ];
}

async function previewState(screen: PreviewScreen): Promise<HudState> {
  const { initialHudState } = await import("../src/ui-hud-model.js");
  const state: HudState = {
    ...initialHudState("/workspace/glossa-preview"),
    accessProfile: "system",
    deviceName: "Preview workstation",
    connection: "connected",
    connectedBefore: true,
    activities: previewActivities(PREVIEW_NOW),
    status: {
      relay: "Local preview relay",
      activeWorkers: 2,
      devices: [
        { id: "preview-device-1", name: "Preview workstation", platform: "darwin-arm64", lastSeen: "just now", status: "1 active worker" },
        { id: "preview-device-2", name: "Build machine", platform: "linux-x64", lastSeen: "3m ago", status: "idle" },
      ],
    },
  };
  if (screen === "activity-empty") return { ...state, view: "activity", activities: [] };
  return { ...state, view: screen };
}

function paletteColor(index: number): string {
  if (index < 16) return ANSI_16[index] ?? FOREGROUND;
  if (index < 232) {
    const value = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(value / 36)]!;
    const green = levels[Math.floor((value % 36) / 6)]!;
    const blue = levels[value % 6]!;
    return `rgb(${red},${green},${blue})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

function rgbColor(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function terminalSvg(ansi: string, columns: number, rows: number): Promise<string> {
  const terminal = new Terminal({ cols: columns, rows, convertEol: true, allowProposedApi: true, scrollback: 0 });
  await new Promise<void>((resolve) => terminal.write(ansi, resolve));

  const width = PADDING * 2 + columns * CELL_WIDTH;
  const height = PADDING * 2 + rows * CELL_HEIGHT;
  const elements = [`<rect width="${width}" height="${height}" fill="${BACKGROUND}"/>`];
  const buffer = terminal.buffer.active;

  for (let row = 0; row < rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) continue;
    for (let column = 0; column < columns; column += 1) {
      const cell = line.getCell(column);
      if (!cell || cell.getWidth() === 0) continue;

      let foreground = cell.isFgRGB() ? rgbColor(cell.getFgColor()) : cell.isFgPalette() ? paletteColor(cell.getFgColor()) : FOREGROUND;
      let background = cell.isBgRGB() ? rgbColor(cell.getBgColor()) : cell.isBgPalette() ? paletteColor(cell.getBgColor()) : BACKGROUND;
      if (cell.isInverse()) [foreground, background] = [background, foreground];

      const x = PADDING + column * CELL_WIDTH;
      const y = PADDING + row * CELL_HEIGHT;
      if (background !== BACKGROUND) {
        elements.push(`<rect x="${x}" y="${y}" width="${CELL_WIDTH * cell.getWidth()}" height="${CELL_HEIGHT}" fill="${background}"/>`);
      }

      const chars = cell.getChars();
      if (!chars || cell.isInvisible()) continue;
      const weight = cell.isBold() ? "700" : "400";
      const style = cell.isItalic() ? ' font-style="italic"' : "";
      const decorations = [cell.isUnderline() ? "underline" : "", cell.isStrikethrough() ? "line-through" : ""].filter(Boolean).join(" ");
      const decoration = decorations ? ` text-decoration="${decorations}"` : "";
      const opacity = cell.isDim() ? ' opacity="0.65"' : "";
      elements.push(`<text x="${x}" y="${y + FONT_SIZE + 1}" fill="${foreground}" font-weight="${weight}"${style}${decoration}${opacity}>${xml(chars)}</text>`);
    }
  }
  terminal.dispose();

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g font-family="DejaVu Sans Mono" font-size="${FONT_SIZE}" xml:space="preserve">${elements.join("")}</g></svg>`;
}

async function renderPng(ansi: string, columns: number, rows: number): Promise<Buffer> {
  const svg = await terminalSvg(ansi, columns, rows);
  return Buffer.from(new Resvg(svg, {
    font: {
      defaultFontFamily: "DejaVu Sans Mono",
      fontFiles,
      loadSystemFonts: false,
    },
  }).render().asPng());
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === "help") {
    console.log(usage());
    return;
  }
  if (options.clean) {
    await rm(previewDirectory, { recursive: true, force: true });
    console.log("Removed .hud-preview/.");
    return;
  }

  process.env.FORCE_COLOR = "3";
  const [{ renderHud }, state] = await Promise.all([import("../src/ui-hud.js"), previewState(options.screen)]);
  const plain = renderHud(state, options.columns, false, options.rows, PREVIEW_NOW);
  const ansi = renderHud(state, options.columns, true, options.rows, PREVIEW_NOW);
  const png = await renderPng(ansi, options.columns, options.rows);

  await rm(previewDirectory, { recursive: true, force: true });
  await mkdir(previewDirectory, { recursive: true });
  await writeFile(previewImage, png);

  console.log(plain);
  console.log("");
  console.log(`Preview: .hud-preview/current.png (${options.screen}, ${options.columns}x${options.rows})`);
  console.log("Each run replaces the preview directory. Use --clean to remove it.");
}

await main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(error.message);
    console.error("");
    console.error(usage());
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
