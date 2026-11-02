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

/** A poster's size in cells for a given height in rows: a poster is 2:3 and a
 *  cell is about 1:2, so it is 4/3 as many columns as rows. Pure. */
export function posterSize(rows: number): { cols: number; rows: number } {
  return { cols: Math.round((rows * 4) / 3), rows };
}

// The placeholder character, and the marks that tell the terminal which row of
// the picture a cell shows (kitty's rowcolumn-diacritics list, first entries).
const CELL = "\u{10EEEE}";
const MARKS = [
  0x305, 0x30d, 0x30e, 0x310, 0x312, 0x33d, 0x33e, 0x33f, 0x346, 0x34a, 0x34b, 0x34c, 0x350, 0x351, 0x352, 0x357,
  0x35b, 0x363, 0x364, 0x365, 0x366, 0x367, 0x368, 0x369, 0x36a, 0x36b, 0x36c, 0x36d, 0x36e, 0x36f,
].map((code) => String.fromCodePoint(code));

/** The text lines that draw picture `id`: the id travels as the cells' 24-bit
 *  colour; each row's first cell names its row and column 0, and the cells
 *  after it count on by themselves. Pure. */
export function placeholderLines(id: number, cols: number, rows: number): string[] {
  const colour = `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`;
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    lines.push(colour + CELL + MARKS[row] + MARKS[0] + CELL.repeat(cols - 1) + "\x1b[39m");
  }
  return lines;
}

// One picture per poster per size: the terminal scales a picture to the cells
// it was sent for, so a big and a small copy are two pictures.
const shown = new Map<string, number>(); // "url|cols|rows" -> picture id in the terminal
const loading = new Set<string>();
// The terminal keeps pictures after flick quits, so each run numbers its own
// from a random point: a new run never draws an old run's picture.
let nextId = 1 + Math.floor(Math.random() * 0xfff000);

/** The id of a poster the terminal already has at this size, or null. */
export function posterId(url: string, cols: number, rows: number): number | null {
  return shown.get(`${url}|${cols}|${rows}`) ?? null;
}

// Each poster's colour, lifted so it reads on the dark background (see tintFrom).
const tints = new Map<string, string>(); // poster URL -> "#RRGGBB"

/** A poster's colour, once it has loaded, or null. */
export function posterTint(url: string): string | null {
  return tints.get(url) ?? null;
}

// Called whenever a poster finishes loading, so the screen can redraw.
export const posterEvents = { onReady: () => {} };

/** Fetch a poster, convert it, and send it to the terminal. Resolves once it
 *  can be drawn (or quietly never, if anything fails). */
export async function loadPoster(url: string, cols: number, rows: number): Promise<void> {
  const key = `${url}|${cols}|${rows}`;
  if (!POSTERS || !url || shown.has(key) || loading.has(key)) return;
  loading.add(key);
  try {
    const png = await posterPng(url);
    if (!tints.has(url)) tints.set(url, await posterColour(png));
    const id = nextId++;
    sendPicture(id, readFileSync(png), cols, rows);
    shown.set(key, id);
    posterEvents.onReady();
  } catch {
    // no poster for this one
  } finally {
    loading.delete(key);
  }
}

/** A poster's average colour as a readable accent, worked out once and kept
 *  next to the poster. `sips` shrinks it to one pixel, saved as a BMP: an
 *  uncompressed format whose pixel bytes are easy to read. */
async function posterColour(png: string): Promise<string> {
  const saved = png.replace(/\.png$/, ".tint");
  if (existsSync(saved)) return readFileSync(saved, "utf-8");
  const bmp = png.replace(/\.png$/, ".bmp");
  await run("sips", ["-s", "format", "bmp", "-z", "1", "1", png, "--out", bmp]);
  const data = readFileSync(bmp);
  rmSync(bmp, { force: true });
  const at = data.readUInt32LE(10); // where the pixels start; stored blue, green, red
  const tint = tintFrom(data[at + 2], data[at + 1], data[at]);
  writeFileSync(saved, tint);
  return tint;
}

/** A colour turned into an accent that reads on a near-black background: the
 *  same hue, lightness lifted to 0.62-0.8, a little saturation added unless it
 *  is grey. Pure. */
export function tintFrom(r: number, g: number, b: number): string {
  // to hue, saturation, lightness (all 0-1)
  const [rf, gf, bf] = [r / 255, g / 255, b / 255];
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  let l = (max + min) / 2;
  let s = 0;
  let h = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rf) h = (gf - bf) / d + (gf < bf ? 6 : 0);
    else if (max === gf) h = (bf - rf) / d + 2;
    else h = (rf - gf) / d + 4;
    h /= 6;
  }
  l = Math.min(0.8, Math.max(0.62, l));
  if (s > 0.08) s = Math.max(0.5, s);
  // back to red, green, blue
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${hex(channel(h + 1 / 3))}${hex(channel(h))}${hex(channel(h - 1 / 3))}`.toUpperCase();
}

/** The poster as a PNG file, from the cache folder or downloaded and converted once. */
async function posterPng(url: string): Promise<string> {
  mkdirSync(POSTER_DIR, { recursive: true });
  // IMDb's image server resizes on request: 400 px wide is sharp at these
  // sizes and quick to convert and send.
  const sized = url.replace(/\._V1_.*\.jpg$/, "._V1_SX400.jpg");
  const name = createHash("sha1").update(sized).digest("hex");
  const png = join(POSTER_DIR, `${name}.png`);
  if (!existsSync(png)) {
    const res = await fetch(sized);
    if (!res.ok) throw new Error(`poster ${res.status}`);
    const jpg = join(POSTER_DIR, `${name}.jpg`);
    writeFileSync(jpg, Buffer.from(await res.arrayBuffer()));
    await run("sips", ["-s", "format", "png", jpg, "--out", png]);
    rmSync(jpg, { force: true });
  }
  return png;
}

/** Send a PNG to the terminal as picture `id`, with a virtual placement of
 *  `cols` x `rows` cells that the placeholder cells draw from. Chunked: the protocol takes 4096 bytes at a time. */
function sendPicture(id: number, png: Buffer, cols: number, rows: number) {
  const data = png.toString("base64");
  let out = "";
  for (let i = 0; i < data.length; i += 4096) {
    const more = i + 4096 < data.length ? 1 : 0;
    const head = i === 0 ? `a=t,f=100,i=${id},q=2,m=${more}` : `m=${more}`;
    out += `\x1b_G${head};${data.slice(i, i + 4096)}\x1b\\`;
  }
  // The placement is its own command: Ghostty only takes the size (c, r) from
  // a placement command, and otherwise draws the picture at its pixel size.
  out += `\x1b_Ga=p,U=1,i=${id},c=${cols},r=${rows},q=2\x1b\\`;
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
