// Film posters in the terminal, through the kitty graphics protocol's Unicode
// placeholders: the picture is sent to the terminal once, then drawn by
// ordinary text cells (a special character, coloured with the picture's id).
// Ink lays those cells out like any other text, so the poster moves and
// disappears with the layout without any cursor tricks.
// Works in kitty and Ghostty. Anywhere else flick simply shows no poster.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR } from "./store.ts";

const POSTER_DIR = join(CACHE_DIR, "posters");

// ponytail: macOS only, because `sips` (built into macOS) turns IMDb's JPEGs
// into the PNGs the protocol needs. A JPEG decoder package would lift that.
export const POSTERS =
  process.platform === "darwin" &&
  !process.env.TMUX &&
  (process.env.TERM_PROGRAM === "ghostty" || process.env.TERM === "xterm-kitty" || Boolean(process.env.KITTY_WINDOW_ID));

// A poster is 2:3 and a terminal cell is about 1:2, so 18 x 13 cells looks right.
export const POSTER_COLS = 18;
export const POSTER_ROWS = 13;

// The placeholder character, and the marks that tell the terminal which row of
// the picture a cell shows (kitty's rowcolumn-diacritics list, first entries).
const CELL = "\u{10EEEE}";
const MARKS = [
  0x305, 0x30d, 0x30e, 0x310, 0x312, 0x33d, 0x33e, 0x33f, 0x346, 0x34a, 0x34b, 0x34c, 0x350, 0x351, 0x352, 0x357,
  0x35b, 0x363, 0x364, 0x365, 0x366, 0x367, 0x368, 0x369, 0x36a, 0x36b, 0x36c, 0x36d, 0x36e, 0x36f,
].map((code) => String.fromCodePoint(code));

/** The text lines that draw picture `id`: each row's first cell names its row
 *  and column 0; the cells after it count on by themselves. Pure. */
export function placeholderLines(id: number, cols: number, rows: number): string[] {
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    lines.push(`\x1b[38;5;${id}m` + CELL + MARKS[row] + MARKS[0] + CELL.repeat(cols - 1) + "\x1b[39m");
  }
  return lines;
}

const shown = new Map<string, number>(); // poster URL -> picture id in the terminal
const loading = new Set<string>();
let nextId = 1; // ids 1-255, because the id travels as a 256-colour number

/** The id of a poster the terminal already has, or null. */
export function posterId(url: string): number | null {
  return shown.get(url) ?? null;
}

/** Fetch a poster, convert it, and send it to the terminal. Resolves once it
 *  can be drawn (or quietly never, if anything fails). */
export async function loadPoster(url: string): Promise<void> {
  if (!POSTERS || !url || shown.has(url) || loading.has(url)) return;
  loading.add(url);
  try {
    const png = await posterPng(url);
    const id = nextId;
    nextId = nextId === 255 ? 1 : nextId + 1;
    for (const [oldUrl, oldId] of shown) if (oldId === id) shown.delete(oldUrl); // that id gets reused
    sendPicture(id, png);
    shown.set(url, id);
  } catch {
    // no poster for this one
  } finally {
    loading.delete(url);
  }
}

/** The poster as PNG, from the cache folder or downloaded and converted once. */
async function posterPng(url: string): Promise<Buffer> {
  mkdirSync(POSTER_DIR, { recursive: true });
  const name = createHash("sha1").update(url).digest("hex");
  const png = join(POSTER_DIR, `${name}.png`);
  if (!existsSync(png)) {
    // IMDb's image server resizes on request: 300 px wide is plenty for 18 cells.
    const small = url.replace(/\._V1_.*\.jpg$/, "._V1_SX300.jpg");
    const res = await fetch(small);
    if (!res.ok) throw new Error(`poster ${res.status}`);
    const jpg = join(POSTER_DIR, `${name}.jpg`);
    writeFileSync(jpg, Buffer.from(await res.arrayBuffer()));
    await run("sips", ["-s", "format", "png", jpg, "--out", png]);
    rmSync(jpg, { force: true });
  }
  return readFileSync(png);
}

/** Send a PNG to the terminal as picture `id`, with a virtual placement the
 *  placeholder cells draw from. Chunked: the protocol takes 4096 bytes at a time. */
function sendPicture(id: number, png: Buffer) {
  const data = png.toString("base64");
  let out = "";
  for (let i = 0; i < data.length; i += 4096) {
    const more = i + 4096 < data.length ? 1 : 0;
    const head = i === 0 ? `a=T,U=1,f=100,i=${id},c=${POSTER_COLS},r=${POSTER_ROWS},q=2,m=${more}` : `m=${more}`;
    out += `\x1b_G${head};${data.slice(i, i + 4096)}\x1b\\`;
  }
  process.stdout.write(out);
}

/** Run a program and wait for it (never spawnSync: couch runs a server in this process). */
function run(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${program} exited ${code}`))));
  });
}
