// Film details for the room's end page: Wikidata for the basics and the
// Wikipedia article, IMDb for plot, tagline and credits, Wikipedia's summary
// as the about text. No IMDb rating is shown, on purpose.

import { UA } from "./titles.ts";

export type FilmDetails = {
  imdb: string;
  title: string | null;
  year: number | null;
  runtime: number | null; // seconds
  genres: string[];
  tagline: string | null;
  plot: string | null;
  poster: string | null;
  directors: string[];
  writers: string[];
  stars: string[];
  about: string | null;
};

const cache = new Map<string, FilmDetails>();

export async function filmDetails(imdb: string): Promise<FilmDetails> {
  const known = cache.get(imdb);
  if (known) return known;
  const out: FilmDetails = { imdb, title: null, year: null, runtime: null, genres: [], tagline: null, plot: null, poster: null, directors: [], writers: [], stars: [], about: null };
  let wiki: string | null = null;

  // 1. Wikidata: the Wikipedia article and the basic facts.
  try {
    const sparql = `SELECT ?article (MIN(YEAR(?date)) AS ?year) (SAMPLE(?mins) AS ?runtime)
      (GROUP_CONCAT(DISTINCT ?dirLabel; separator="|") AS ?dirs)
      (GROUP_CONCAT(DISTINCT ?genreLabel; separator="|") AS ?genres) WHERE {
      ?f wdt:P345 "${imdb}".
      OPTIONAL { ?article schema:about ?f; schema:isPartOf <https://en.wikipedia.org/> }
      OPTIONAL { ?f wdt:P577 ?date }
      OPTIONAL { ?f wdt:P2047 ?mins }
      OPTIONAL { ?f wdt:P57 ?dir. ?dir rdfs:label ?dirLabel. FILTER(LANG(?dirLabel) = "en") }
      OPTIONAL { ?f wdt:P136 ?genre. ?genre rdfs:label ?genreLabel. FILTER(LANG(?genreLabel) = "en") }
    } GROUP BY ?article LIMIT 1`;
    const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, {
      headers: { "User-Agent": "flick (https://github.com/nitrimandylis/flick)" },
      signal: AbortSignal.timeout(10_000),
    });
    const row = ((await res.json()) as any).results.bindings[0];
    if (row) {
      wiki = row.article?.value ?? null;
      out.year = row.year ? Number(row.year.value) : null;
      out.runtime = row.runtime ? Number(row.runtime.value) * 60 : null;
      out.directors = row.dirs?.value ? row.dirs.value.split("|") : [];
      // "romantic comedy film" -> "Romantic comedy"; keep three
      out.genres = (row.genres?.value ? row.genres.value.split("|") : [])
        .slice(0, 3)
        .map((g: string) => g.replace(/ film$/, ""))
        .map((g: string) => g.charAt(0).toUpperCase() + g.slice(1));
    }
  } catch {}

  // 2. IMDb: plot, tagline, credits, poster.
  try {
    const query = `{ title(id: "${imdb}") { titleText { text } releaseYear { year } runtime { seconds } plot { plotText { plainText } } primaryImage { url } genres { genres { text } } taglines(first: 1) { edges { node { text } } } principalCredits { category { text } credits(limit: 4) { name { nameText { text } } } } } }`;
    const res = await fetch("https://api.graphql.imdb.com/", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA, "x-imdb-client-name": "imdb-web-next", origin: "https://www.imdb.com" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10_000),
    });
    const t = ((await res.json()) as any).data?.title;
    if (t) {
      out.title = t.titleText?.text ?? out.title;
      out.year = t.releaseYear?.year ?? out.year;
      out.runtime = t.runtime?.seconds ?? out.runtime;
      out.plot = t.plot?.plotText?.plainText ?? null;
      out.poster = t.primaryImage?.url ?? null;
      if (t.genres?.genres?.length) out.genres = t.genres.genres.map((g: any) => g.text);
      out.tagline = t.taglines?.edges?.[0]?.node?.text ?? null;
      for (const group of t.principalCredits ?? []) {
        const names = group.credits.map((c: any) => c.name.nameText.text);
        const category: string = group.category.text;
        if (category.startsWith("Director")) out.directors = names;
        else if (category.startsWith("Writer")) out.writers = names;
        else if (category.startsWith("Star")) out.stars = names;
      }
    }
  } catch {}

  // 3. Wikipedia: the article's opening paragraph.
  if (wiki) {
    try {
      const page = wiki.split("/wiki/")[1];
      const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${page}`, {
        headers: { "User-Agent": "flick (https://github.com/nitrimandylis/flick)" },
        signal: AbortSignal.timeout(10_000),
      });
      const w = (await res.json()) as any;
      out.about = w.extract ?? null;
      out.title ??= w.title ?? null;
      out.poster ??= w.originalimage?.source ?? null;
    } catch {}
  }

  if (out.title) cache.set(imdb, out);
  return out;
}
