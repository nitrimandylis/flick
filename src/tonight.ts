// flick tonight: one film from a Letterboxd watchlist that fits the time you
// have. No list to choose from: one film, enter plays it, n asks for another.

import { details, titleById, UA, type Details, type Title } from "./titles.ts";
import { browserPlayable, findSources, pickBest, type Torrent } from "./torrents.ts";

/** A film as a Letterboxd list names it. `slug` is its page: letterboxd.com/film/<slug>/ */
export type Listed = { name: string; year: number | null; slug: string };

/** A film that can play right now: its IMDb title, its facts and a source. */
export type Pick = { title: Title; details: Details; torrent: Torrent };

/** "&amp;" and "&#039;" back into "&" and "'". Pure. */
export function unescapeHtml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The films on one Letterboxd list page. Each poster's tag carries
 *  data-item-name="Title (Year)" and data-item-slug="title-year". Pure. */
export function parseWatchlist(html: string): Listed[] {
  const films: Listed[] = [];
  for (const tag of html.match(/<[^>]*data-item-name="[^>]*>/g) ?? []) {
    const text = unescapeHtml(tag.match(/data-item-name="([^"]*)"/)?.[1] ?? "");
    const slug = tag.match(/data-item-slug="([^"]*)"/)?.[1] ?? "";
    if (!text || !slug) continue;
    const parts = text.match(/^(.*) \((\d{4})\)$/);
    if (parts) films.push({ name: parts[1], year: Number(parts[2]), slug });
    else films.push({ name: text, year: null, slug });
  }
  return films;
}

/** A public Letterboxd watchlist, every page of it. Empty when the user has
 *  none or Letterboxd doesn't answer. */
export async function fetchWatchlist(user: string): Promise<Listed[]> {
  const films: Listed[] = [];
  for (let page = 1; page <= 50; page++) {
    let html = "";
    try {
      const res = await fetch(`https://letterboxd.com/${encodeURIComponent(user)}/watchlist/page/${page}/`, {
        headers: { "User-Agent": UA },
      });
      if (!res.ok) break;
      html = await res.text();
    } catch {
      break;
    }
    const found = parseWatchlist(html);
    if (!found.length) break; // past the last page
    films.push(...found);
  }
  return films;
}

/** The IMDb id on a Letterboxd film page (it links to the film on IMDb), or
 *  null. Pure. */
export function parseImdbId(html: string): string | null {
  return html.match(/imdb\.com\/title\/(tt\d+)/)?.[1] ?? null;
}

/** The IMDb id of a Letterboxd film, read from its page. Going through the id
 *  means a remake or a namesake is never played by mistake. */
async function imdbIdOf(slug: string): Promise<string | null> {
  try {
    const res = await fetch(`https://letterboxd.com/film/${slug}/`, { headers: { "User-Agent": UA } });
    return res.ok ? parseImdbId(await res.text()) : null;
  } catch {
    return null;
  }
}

/** A copy of `list` in random order (Fisher-Yates). */
export function shuffled<T>(list: T[], random: () => number = Math.random): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Does a film of `minutes` fit in `limit` minutes? No limit fits everything;
 *  with a limit, a film of unknown length (0) doesn't count as fitting. Pure. */
export function fits(minutes: number, limit: number | null): boolean {
  if (limit === null) return true;
  return minutes > 0 && minutes <= limit;
}

/** The next film in `queue` that can play tonight: it is a film on IMDb, it fits in
 *  `limit` minutes, and there is a source flick would pick. Films are taken off
 *  the front of `queue` as they are tried, so calling again gives another.
 *  Null when the queue runs out. `couch` keeps only files a browser plays. */
export async function nextPick(queue: Listed[], limit: number | null, couch: boolean): Promise<Pick | null> {
  while (queue.length) {
    const film = queue.shift()!;
    const id = await imdbIdOf(film.slug);
    if (!id) continue;
    const title = await titleById(id);
    if (!title || (title.kind !== "movie" && title.kind !== "tvMovie")) continue; // tonight is for films
    const facts = await details(title.id);
    if (!fits(facts.minutes, limit)) continue;
    const report = await findSources({ kind: "film", title });
    const torrents = couch ? report.torrents.filter((t) => browserPlayable(t.name)) : report.torrents;
    const torrent = pickBest(torrents);
    if (!torrent) continue; // not out yet, or nothing good enough to just play
    return { title, details: facts, torrent };
  }
  return null;
}
