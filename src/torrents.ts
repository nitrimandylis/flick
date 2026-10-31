// Torrent sources for one title. Films and episodes are looked up by IMDb id
// where the source supports it (YTS, EZTV), so there is no guessing from names;
// the general indexes (The Pirate Bay's API, Knaben) and Nyaa fill in the rest.
// Source list after torlink (github.com/baairon/torlink, MIT), which curated it.

import { UA, sxxeyy, type Title } from "./titles.ts";

export type Torrent = {
  name: string;
  infoHash: string; // lowercase hex
  magnet: string;
  seeders: number;
  bytes: number; // 0 when the source doesn't say
  source: string;
};

// What to find sources for: a film, a TV episode, or an anime episode.
export type Wanted =
  | { kind: "film"; title: Title }
  | { kind: "episode"; title: Title; season: number; episode: number }
  | { kind: "anime"; title: Title; queries: string[] };

// Public trackers added to bare info hashes so the client finds peers.
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
];

export function magnetFromHash(hash: string, name: string): string {
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${hash.toLowerCase()}&dn=${encodeURIComponent(name)}${trackers}`;
}

/** A magnet with flick's public trackers added (skipping ones it already has).
 *  Pasted magnets often carry no trackers, and without them peers are slow or
 *  impossible to find. Pure. */
export function withTrackers(magnet: string): string {
  const missing = TRACKERS.filter((t) => !magnet.includes(encodeURIComponent(t)) && !magnet.includes(t));
  return magnet + missing.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
}

/** The info hash inside a magnet link, lowercase, or "" if there isn't one. Pure. */
export function hashOf(magnet: string): string {
  return magnet.match(/btih:([a-z0-9]+)/i)?.[1]?.toLowerCase() ?? "";
}

export function humanSize(bytes: number): string {
  if (!bytes || bytes < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Resolution, HDR, codec and release type pulled out of a torrent's name. Pure. */
export function parseQuality(name: string): { res: string; hdr: string; codec: string; src: string } {
  const res =
    name.match(/\b(2160p|1080p|720p|480p)\b/i)?.[1].toLowerCase() ?? (/\b(4k|uhd)\b/i.test(name) ? "2160p" : "");
  const hdr = /\b(dolby\s*vision|dv)\b/i.test(name) ? "DV" : /\bhdr10\+?\b|\bhdr\b/i.test(name) ? "HDR" : "";
  const codec = /\b(x265|h\.?\s?265|hevc)\b/i.test(name)
    ? "x265"
    : /\b(x264|h\.?\s?264|avc)\b/i.test(name)
      ? "x264"
      : /\bav1\b/i.test(name)
        ? "AV1"
        : "";
  const raw = name.match(/\b(REMUX|BluRay|BDRip|BRRip|WEB[- .]?DL|WEBRip|WEB|HDTV|DVDRip|HDCAM|CAM)\b/i)?.[1] ?? "";
  const src = /^web[- .]?dl$/i.test(raw) ? "WEB-DL" : /^web$/i.test(raw) ? "WEB" : raw;
  return { res, hdr, codec, src };
}

export function qualityLabel(name: string): string {
  const q = parseQuality(name);
  return [q.res, q.hdr, q.codec, q.src].filter(Boolean).join(" ") || "-";
}

/** Whether a file every browser plays: MP4 with H.264 video. YTS/YIFY releases
 *  are; others must say x264 and mp4. Used by `flick couch`. Pure. */
export function browserPlayable(name: string): boolean {
  if (/\b(x265|h\.?\s?265|hevc|10.?bit|av1)\b/i.test(name)) return false;
  if (/\b(yts|yify)\b/i.test(name)) return true;
  return /\b(x264|h\.?\s?264|avc)\b/i.test(name) && /\bmp4\b/i.test(name);
}

/** Is torrent `name` really show `title` (and not a longer show that starts
 *  the same way)? "House of the Dragon" is not "House". `tag` is the SxxEyy or
 *  year that follows the show's name. A name without the tag is kept. Pure. */
export function matchesShow(name: string, title: string, tag: string): boolean {
  const words = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const at = tag ? words.indexOf(tag.toLowerCase()) : -1;
  if (at < 0) return true;
  const before = words.slice(0, at).trim().split(/\s+/).filter(Boolean);
  if (before.length && /^(19|20)\d\d$/.test(before[before.length - 1])) before.pop();
  const show = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!before.length || !show.length) return true;
  if (before.length > show.length) return false;
  return before.every((word, i) => word === show[i]);
}

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

// ---------- the sources ----------

// yts.mx is often blocked; the mirrors redirect to whichever domain is live.
const YTS_HOSTS = ["yts.mx", "yts.am", "yts.rs"];

/** YTS by IMDb id: one film, its MP4 H.264 releases. */
async function yts(imdbId: string): Promise<Torrent[]> {
  for (const host of YTS_HOSTS) {
    try {
      const json = await getJson(`https://${host}/api/v2/list_movies.json?query_term=${imdbId}`);
      const film = (json.data?.movies ?? []).find((m: any) => m.imdb_code === imdbId);
      if (!film) return [];
      return (film.torrents ?? []).map((t: any) => {
        const name = `${film.title_long} [${[t.quality, t.type].filter(Boolean).join(" ")}] [YTS]`;
        return {
          name,
          infoHash: String(t.hash).toLowerCase(),
          magnet: magnetFromHash(t.hash, name),
          seeders: t.seeds ?? 0,
          bytes: t.size_bytes ?? 0,
          source: "YTS",
        };
      });
    } catch {
      // try the next mirror
    }
  }
  return [];
}

/** EZTV by IMDb id, filtered to one episode. */
async function eztv(imdbId: string, season: number, episode: number): Promise<Torrent[]> {
  const id = imdbId.replace(/^tt/, "");
  const out: Torrent[] = [];
  for (let page = 1; page <= 5; page++) {
    const json = await getJson(`https://eztvx.to/api/get-torrents?imdb_id=${id}&limit=100&page=${page}`);
    const rows: any[] = json.torrents ?? [];
    for (const t of rows) {
      if (Number(t.season) !== season || Number(t.episode) !== episode || !t.hash) continue;
      out.push({
        name: t.title ?? t.filename ?? "",
        infoHash: String(t.hash).toLowerCase(),
        magnet: t.magnet_url || magnetFromHash(t.hash, t.title ?? ""),
        seeders: Number(t.seeds) || 0,
        bytes: Number(t.size_bytes) || 0,
        source: "EZTV",
      });
    }
    if (rows.length < 100) break;
  }
  return out;
}

/** The Pirate Bay's JSON API. Keeps video categories (2xx) only. */
async function piratebay(query: string): Promise<Torrent[]> {
  const rows: any[] = await getJson(`https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`);
  return rows
    .filter((r) => r.info_hash && !/^0+$/.test(r.info_hash) && String(r.category).startsWith("2"))
    .map((r) => ({
      name: r.name,
      infoHash: String(r.info_hash).toLowerCase(),
      magnet: magnetFromHash(r.info_hash, r.name),
      seeders: Number(r.seeders) || 0,
      bytes: Number(r.size) || 0,
      source: "TPB",
    }));
}

/** Knaben, an index of many trackers at once. */
async function knaben(query: string): Promise<Torrent[]> {
  const json = await getJson("https://api.knaben.org/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, order_by: "seeders", order_direction: "desc", size: 50 }),
  });
  return (json.hits ?? [])
    .filter((h: any) => h.hash || h.magnetUrl)
    .map((h: any) => ({
      name: h.title ?? "",
      infoHash: String(h.hash ?? hashOf(h.magnetUrl ?? "")).toLowerCase(),
      magnet: h.magnetUrl || magnetFromHash(h.hash, h.title ?? ""),
      seeders: Number(h.seeders) || 0,
      bytes: Number(h.bytes) || 0,
      source: h.tracker ?? "Knaben",
    }));
}

/** Nyaa's RSS search, English-translated anime only. */
async function nyaa(query: string): Promise<Torrent[]> {
  const res = await fetch(`https://nyaa.si/?page=rss&c=1_2&f=0&q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`nyaa answered ${res.status}`);
  const items = (await res.text()).match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items
    .map((item) => {
      const name = (item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").replace(/&amp;/g, "&").trim();
      const hash = item.match(/<nyaa:infoHash>([\s\S]*?)<\/nyaa:infoHash>/)?.[1]?.trim() ?? "";
      const size = item.match(/<nyaa:size>([\d.]+)\s*(KiB|MiB|GiB)<\/nyaa:size>/);
      const scale = size ? { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[size[2] as "KiB"] : 0;
      return {
        name,
        infoHash: hash.toLowerCase(),
        magnet: hash ? magnetFromHash(hash, name) : "",
        seeders: Number(item.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/)?.[1]) || 0,
        bytes: size ? Math.round(Number(size[1]) * scale) : 0,
        source: "Nyaa",
      };
    })
    .filter((t) => t.infoHash);
}

// ---------- putting them together ----------

export type SourceReport = { torrents: Torrent[]; offline: string[] };

/** Every source that applies to `wanted`, asked at once. Results are merged,
 *  de-duplicated by info hash, and sorted by seeders. Sources that fail are
 *  named in `offline` instead of failing the whole search. */
export async function findSources(wanted: Wanted): Promise<SourceReport> {
  const jobs: { name: string; run: () => Promise<Torrent[]> }[] = [];
  const t = wanted.title;

  if (wanted.kind === "film") {
    const query = t.year ? `${t.name} ${t.year}` : t.name;
    jobs.push({ name: "YTS", run: () => yts(t.id) });
    jobs.push({ name: "TPB", run: () => piratebay(query) });
    jobs.push({ name: "Knaben", run: () => knaben(query) });
  } else if (wanted.kind === "episode") {
    const query = `${t.name} ${sxxeyy(wanted.season, wanted.episode)}`;
    jobs.push({ name: "EZTV", run: () => eztv(t.id, wanted.season, wanted.episode) });
    jobs.push({ name: "TPB", run: () => piratebay(query) });
    jobs.push({ name: "Knaben", run: () => knaben(query) });
  } else {
    for (const query of wanted.queries.slice(0, 4)) {
      jobs.push({ name: "Nyaa", run: () => nyaa(query) });
    }
  }

  const settled = await Promise.allSettled(jobs.map((job) => job.run()));
  const offline = new Set<string>();
  const seen = new Set<string>();
  const torrents: Torrent[] = [];
  settled.forEach((result, i) => {
    if (result.status === "rejected") {
      offline.add(jobs[i].name);
      return;
    }
    for (const torrent of result.value) {
      if (!torrent.infoHash || seen.has(torrent.infoHash)) continue;
      seen.add(torrent.infoHash);
      torrents.push(torrent);
    }
  });

  // Drop releases of a different, longer show ("House" vs "House of the Dragon").
  let kept = torrents;
  if (wanted.kind !== "anime") {
    const tag = wanted.kind === "episode" ? sxxeyy(wanted.season, wanted.episode) : String(t.year ?? "");
    const relevant = torrents.filter((x) => matchesShow(x.name, t.name, tag));
    if (relevant.length) kept = relevant;
  }
  kept.sort((a, b) => b.seeders - a.seeders);
  return { torrents: kept, offline: [...offline] };
}
