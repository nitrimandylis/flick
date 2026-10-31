// Films and shows: what the search bar finds before any torrent is involved.
// Everything here comes from IMDb's public, keyless endpoints.

const IMDB_SUGGEST = "https://v2.sg.media-imdb.com/suggestion";
const IMDB_GRAPHQL = "https://api.graphql.imdb.com/";
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

export type Title = {
  id: string; // IMDb id, "tt0137523"
  name: string;
  year: number | null;
  kind: string; // "movie", "tvSeries", "tvMiniSeries", "tvMovie"
  poster: string; // image URL, may be empty
  cast: string; // a few names, from the suggestion API
  rating: number | null; // filled in by details()
};

export type Episode = { season: number; number: number; name: string; rating: number | null };

const KINDS = new Set(["movie", "tvSeries", "tvMovie", "tvMiniSeries"]);

export function isSeries(t: Title): boolean {
  return t.kind === "tvSeries" || t.kind === "tvMiniSeries";
}

/** Titles from IMDb's suggestion API response. Pure. */
export function parseSuggestions(list: any[]): Title[] {
  return (list ?? [])
    .filter((x) => typeof x?.id === "string" && x.id.startsWith("tt") && KINDS.has(x.qid))
    .map((x) => ({
      id: x.id,
      name: x.l ?? "",
      year: typeof x.y === "number" ? x.y : null,
      kind: x.qid,
      poster: x.i?.imageUrl ?? "",
      cast: typeof x.s === "string" ? x.s : "",
      rating: null,
    }));
}

/** The search bar: films and shows matching what was typed. */
export async function searchTitles(query: string, signal?: AbortSignal): Promise<Title[]> {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const first = q.replace(/[^a-z0-9]/g, "")[0] ?? "x";
  try {
    const res = await fetch(`${IMDB_SUGGEST}/${first}/${encodeURIComponent(q)}.json`, {
      headers: { "User-Agent": UA },
      signal,
    });
    if (!res.ok) return [];
    return parseSuggestions(((await res.json()) as any).d ?? []);
  } catch {
    return [];
  }
}

async function graphql(query: string): Promise<any> {
  try {
    // Without these browser-like headers IMDb's GraphQL answers 403.
    const res = await fetch(IMDB_GRAPHQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        "x-imdb-client-name": "imdb-web-next",
        Origin: "https://www.imdb.com",
      },
      body: JSON.stringify({ query }),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Titles from an IMDb popularity search (the "trending" list). Pure. */
export function parseTrending(json: any): Title[] {
  const edges = json?.data?.advancedTitleSearch?.edges ?? [];
  return edges
    .map((e: any) => e.node?.title)
    .filter((t: any) => typeof t?.id === "string" && t.id.startsWith("tt"))
    .map((t: any) => ({
      id: t.id,
      name: t.titleText?.text ?? "",
      year: t.releaseYear?.year ?? null,
      kind: t.titleType?.id ?? "",
      poster: t.primaryImage?.url ?? "",
      cast: "",
      rating: t.ratingsSummary?.aggregateRating ?? null,
    }));
}

/** The most popular films or shows right now, by IMDb's daily popularity. */
export async function trending(kind: "movie" | "tvSeries"): Promise<Title[]> {
  const json = await graphql(
    `query { advancedTitleSearch(first: 20, sort: {sortBy: POPULARITY, sortOrder: ASC}, constraints: {titleTypeConstraint: {anyTitleTypeIds: ["${kind}"]}}) { edges { node { title { id titleText { text } releaseYear { year } titleType { id } ratingsSummary { aggregateRating } primaryImage { url } } } } } }`,
  );
  return parseTrending(json);
}

/** Rating, plot and runtime for one title, for the details pane. */
export async function details(id: string): Promise<{ rating: number | null; plot: string; minutes: number; genres: string[] }> {
  const json = await graphql(
    `query { title(id: "${id}") { runtime { seconds } ratingsSummary { aggregateRating } plot { plotText { plainText } } genres { genres { text } } } }`,
  );
  const t = json?.data?.title;
  return {
    rating: t?.ratingsSummary?.aggregateRating ?? null,
    plot: t?.plot?.plotText?.plainText ?? "",
    minutes: t?.runtime?.seconds ? Math.round(t.runtime.seconds / 60) : 0,
    genres: (t?.genres?.genres ?? []).map((g: any) => g.text),
  };
}

/** Season numbers of a show, sorted. Pure. */
export function parseSeasons(json: any): number[] {
  return (json?.data?.title?.episodes?.seasons ?? [])
    .map((s: any) => s.number)
    .filter((n: any) => typeof n === "number")
    .sort((a: number, b: number) => a - b);
}

/** Episodes of one season, sorted by number. Pure. */
export function parseEpisodes(json: any): Episode[] {
  return (json?.data?.title?.episodes?.episodes?.edges ?? [])
    .map((e: any) => {
      const node = e.node ?? {};
      const at = node.series?.episodeNumber ?? {};
      return {
        season: at.seasonNumber ?? 0,
        number: at.episodeNumber ?? 0,
        name: node.titleText?.text ?? "",
        rating: node.ratingsSummary?.aggregateRating ?? null,
      };
    })
    .filter((e: Episode) => e.number > 0)
    .sort((a: Episode, b: Episode) => a.number - b.number);
}

export async function seasons(id: string): Promise<number[]> {
  return parseSeasons(await graphql(`query { title(id: "${id}") { episodes { seasons { number } } } }`));
}

export async function episodes(id: string, season: number): Promise<Episode[]> {
  return parseEpisodes(
    await graphql(
      `query { title(id: "${id}") { episodes { episodes(first: 100, filter: {includeSeasons: ["${season}"]}) { edges { node { titleText { text } ratingsSummary { aggregateRating } series { episodeNumber { seasonNumber episodeNumber } } } } } } } }`,
    ),
  );
}

/** "S02E05", how TV torrents name an episode. */
export function sxxeyy(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}
