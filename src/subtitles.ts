// English subtitles: from the torrent if it ships some, else from
// yifysubtitles by IMDb id. Players get an .srt file; the browser gets WebVTT.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUBS_DIR } from "./store.ts";
import { UA } from "./titles.ts";

const YIFY = "https://yifysubtitles.ch";

/** SubRip to WebVTT: a header, and a dot instead of a comma in times. Pure. */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .trim();
  return "WEBVTT\n\n" + body + "\n";
}

/** The first English subtitle on a yifysubtitles film page. Matches the
 *  language cell, so a title with "English" in it doesn't confuse it. Pure. */
export function parseYifyEnglish(html: string): string | null {
  for (const row of html.split(/<tr\b/i)) {
    if (/sub-lang">\s*English\b/i.test(row)) {
      const link = row.match(/href="\/subtitles\/([^"]+)"/);
      if (link) return link[1];
    }
  }
  return null;
}

/** Download (once) an English .srt for an IMDb id. Returns its path, or null. */
async function fromYify(imdbId: string): Promise<string | null> {
  const srt = join(SUBS_DIR, `${imdbId}.srt`);
  if (existsSync(srt)) return srt;
  try {
    const page = await fetch(`${YIFY}/movie-imdb/${imdbId}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!page.ok) return null;
    const slug = parseYifyEnglish(await page.text());
    if (!slug) return null;
    // the download refuses requests that don't come from the subtitle's page
    const zip = await fetch(`${YIFY}/subtitle/${slug}.zip`, {
      headers: { "User-Agent": UA, Referer: `${YIFY}/subtitles/${slug}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!zip.ok) return null;
    mkdirSync(SUBS_DIR, { recursive: true });
    const zipPath = join(SUBS_DIR, `${imdbId}.zip`);
    const unpacked = join(SUBS_DIR, imdbId);
    writeFileSync(zipPath, new Uint8Array(await zip.arrayBuffer()));
    spawnSync("unzip", ["-o", "-j", zipPath, "-d", unpacked], { stdio: "ignore" });
    rmSync(zipPath, { force: true });
    const file = existsSync(unpacked) ? readdirSync(unpacked).find((f) => f.toLowerCase().endsWith(".srt")) : undefined;
    if (file) renameSync(join(unpacked, file), srt);
    rmSync(unpacked, { recursive: true, force: true });
    return file ? srt : null;
  } catch {
    return null;
  }
}

/** An English .srt for this film: the torrent's own if it has one (`torrentUrl`
 *  is its stream URL), else yifysubtitles. Returns the local path and the VTT. */
export async function englishSubtitles(
  imdbId: string,
  torrentSub: { url: string; name: string } | null,
): Promise<{ path: string; vtt: string } | null> {
  let path: string | null = null;
  if (torrentSub && /\.srt$/i.test(torrentSub.name)) {
    try {
      const text = await (await fetch(torrentSub.url)).text();
      mkdirSync(SUBS_DIR, { recursive: true });
      path = join(SUBS_DIR, `${imdbId}-torrent.srt`);
      writeFileSync(path, text);
    } catch {
      path = null;
    }
  }
  if (!path && /^tt\d+$/.test(imdbId)) path = await fromYify(imdbId);
  if (!path) return null;
  return { path, vtt: srtToVtt(readFileSync(path, "utf-8")) };
}
