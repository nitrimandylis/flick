// Anime numbering. IMDb numbers anime as SxxEyy, but anime torrents (Nyaa,
// SubsPlease) use the romaji title plus one running episode number, so anime
// gets its episode list and search terms from AniList instead.

import { UA } from "./titles.ts";

export type Anime = {
  romaji: string;
  episodes: number;
  episodeNames: Record<number, string>;
  english?: string;
  synonyms?: string[];
};

/** One AniList media entry as an Anime, or null when it isn't usable. Pure. */
export function parseAnime(m: any): Anime | null {
  if (!m) return null;
  const romaji = m.title?.romaji || m.title?.english || "";
  // AniList leaves `episodes` empty while a show is airing; count the aired ones
  const aired = typeof m.nextAiringEpisode?.episode === "number" ? m.nextAiringEpisode.episode - 1 : 0;
  const episodes = typeof m.episodes === "number" ? m.episodes : aired;
  const episodeNames: Record<number, string> = {};
  for (const ep of m.streamingEpisodes ?? []) {
    const match = String(ep?.title ?? "").match(/Episode\s+(\d+)\s*[-–:]\s*(.+)/i);
    if (match) episodeNames[Number(match[1])] = match[2].trim();
  }
  if (!romaji || episodes <= 0) return null;
  const english = m.title?.english && m.title.english !== romaji ? m.title.english : undefined;
  const synonyms = Array.isArray(m.synonyms) && m.synonyms.length ? m.synonyms : undefined;
  return { romaji, episodes, episodeNames, english, synonyms };
}

/** Letters and digits only, for comparing titles loosely. Pure. */
export function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** AniList's search is fuzzy ("House" finds "The House"), so only trust it when
 *  the title matches one of AniList's own names exactly. Pure. */
export function animeMatches(a: Anime, title: string): boolean {
  const want = normKey(title);
  return want !== "" && [a.romaji, a.english ?? "", ...(a.synonyms ?? [])].some((t) => normKey(t) === want);
}

/** The anime behind a show's title, or null if it isn't one. AniList's best
 *  match is sometimes a spin-off ("Frieren" finds its mini anime first), so
 *  look through the top five for one whose name matches exactly. */
export async function findAnime(title: string): Promise<Anime | null> {
  try {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        query:
          "query($q:String){Page(perPage:5){media(search:$q,type:ANIME){episodes synonyms title{romaji english} nextAiringEpisode{episode} streamingEpisodes{title}}}}",
        variables: { q: title },
      }),
    });
    if (!res.ok) return null;
    const list: any[] = ((await res.json()) as any).data?.Page?.media ?? [];
    for (const entry of list) {
      const anime = parseAnime(entry);
      if (anime && animeMatches(anime, title)) return anime;
    }
    return null;
  } catch {
    return null;
  }
}

// Titles in these scripts never match Nyaa's Latin-script release names.
const NON_LATIN = /[Ѐ-ۿ֐-׿฀-๿぀-ヿ㐀-鿿가-힯]/;

/** "Sousou no Frieren 2nd Season" -> "Sousou no Frieren", how fansubbers name it. Pure. */
export function plainTitle(romaji: string): string {
  return romaji
    .replace(/\b(\d+(?:st|nd|rd|th)\s+season|season\s+\d+|part\s+\d+|cour\s+\d+)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Up to four title spellings worth searching for. Pure. */
export function animeTitles(a: Anime): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [a.romaji, a.english ?? "", ...(a.synonyms ?? [])]) {
    const clean = plainTitle(t);
    const key = clean.toLowerCase();
    if (clean && !NON_LATIN.test(clean) && /[a-z]/i.test(clean) && !seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  }
  return out.slice(0, 4);
}

/** Search queries for one episode: each title with a padded and an unpadded
 *  number. `dub` adds "dual audio", the closest thing to a dub tag. Pure. */
export function animeQueries(titles: string[], episode: number, dub: boolean): string[] {
  const padded = String(episode).padStart(2, "0");
  const numbers = padded === String(episode) ? [padded] : [padded, String(episode)];
  const out: string[] = [];
  for (const t of titles) {
    for (const n of numbers) out.push(dub ? `${t} ${n} dual audio` : `${t} ${n}`);
  }
  return out.slice(0, 12);
}
