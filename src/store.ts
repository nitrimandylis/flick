// Everything flick keeps on disk: settings, what you watched, and the films
// themselves (with a size cap so the cache can't grow forever).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".config", "flick");
export const CACHE_DIR = join(homedir(), ".cache", "flick");
export const FILMS_DIR = join(CACHE_DIR, "films"); // torrent downloads
export const SUBS_DIR = join(CACHE_DIR, "subs");

const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const HISTORY_PATH = join(CONFIG_DIR, "history.json");

// ---------- settings ----------

export type Config = {
  engine?: "rqbit" | "webtorrent"; // unset: rqbit if installed, else webtorrent
  player?: "iina" | "mpv" | "vlc" | "browser"; // unset: the first one installed
  cacheGB?: number; // unset: 10
  dub?: boolean; // anime: prefer dual-audio releases
};

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function loadConfig(): Config {
  return readJson<Config>(CONFIG_PATH, {});
}

export function saveConfig(config: Config) {
  writeJson(CONFIG_PATH, config);
}

// ---------- what you watched ----------

export type Watched = {
  id: string; // IMDb id
  name: string;
  year: number | null;
  kind: string;
  poster: string;
  season?: number; // last episode played, for shows
  episode?: number;
  seen?: string[]; // "S01E03" of every episode played, for the ✓ marks
  at: number; // ms
};

const HISTORY_CAP = 40;

export function loadHistory(): Watched[] {
  const list = readJson<Watched[]>(HISTORY_PATH, []);
  return Array.isArray(list) ? list : [];
}

/** Put a title at the top of "continue watching", keeping its watched episodes. */
export function recordPlay(entry: Omit<Watched, "at" | "seen">, episodeTag?: string) {
  const list = loadHistory();
  const old = list.find((w) => w.id === entry.id);
  const seen = new Set(old?.seen ?? []);
  if (episodeTag) seen.add(episodeTag);
  const rest = list.filter((w) => w.id !== entry.id);
  rest.unshift({ ...entry, seen: [...seen], at: Date.now() });
  writeJson(HISTORY_PATH, rest.slice(0, HISTORY_CAP));
}

// ---------- the film cache ----------

/** Total size of a folder, in bytes. */
function folderSize(path: string): number {
  let total = 0;
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    const info = statSync(full);
    total += info.isDirectory() ? folderSize(full) : info.size;
  }
  return total;
}

/** Mark a cached film as just watched, so the cap evicts it last. */
export function touchFilm(folderName: string) {
  const path = join(FILMS_DIR, folderName);
  if (!existsSync(path)) return;
  const now = new Date();
  utimesSync(path, now, now);
}

/** Delete the least recently watched films until the cache is under its cap.
 *  `keep` is the folder about to play, never deleted. Returns what was removed. */
export function trimCache(capGB: number, keep?: string): string[] {
  if (!existsSync(FILMS_DIR)) return [];
  const cap = capGB * 1024 ** 3;
  const films = readdirSync(FILMS_DIR)
    .map((name) => {
      const path = join(FILMS_DIR, name);
      const info = statSync(path);
      return { name, path, at: info.mtimeMs, bytes: info.isDirectory() ? folderSize(path) : info.size };
    })
    .sort((a, b) => a.at - b.at); // oldest first
  let total = films.reduce((sum, f) => sum + f.bytes, 0);
  const removed: string[] = [];
  for (const film of films) {
    if (total <= cap) break;
    if (film.name === keep) continue;
    rmSync(film.path, { recursive: true, force: true });
    total -= film.bytes;
    removed.push(film.name);
  }
  return removed;
}
