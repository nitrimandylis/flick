import { describe, expect, test } from "bun:test";
import { animeMatches, animeQueries, animeTitles, parseAnime, plainTitle } from "./anime.ts";
import { pickSubtitles, pickVideos } from "./engines.ts";
import { parseArgs } from "./cli.tsx";
import { playerPage } from "./players.ts";
import { parseYifyEnglish, srtToVtt } from "./subtitles.ts";
import { parseEpisodes, parseSuggestions, sxxeyy } from "./titles.ts";
import { browserPlayable, hashOf, matchesShow, qualityLabel, withTrackers } from "./torrents.ts";
import { sourceTag, windowOf } from "./ui.tsx";
import { trimCache } from "./store.ts";
import { applySet, currentTime, emptyState } from "./room.ts";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("titles", () => {
  test("suggestions keep films and shows only", () => {
    const list = parseSuggestions([
      { id: "tt0137523", l: "Fight Club", y: 1999, qid: "movie", s: "Brad Pitt" },
      { id: "nm0000093", l: "Brad Pitt", qid: "actor" },
      { id: "tt0903747", l: "Breaking Bad", y: 2008, qid: "tvSeries" },
    ]);
    expect(list.map((t) => t.name)).toEqual(["Fight Club", "Breaking Bad"]);
    expect(list[0].cast).toBe("Brad Pitt");
  });
  test("episodes are sorted and numbered", () => {
    const json = { data: { title: { episodes: { episodes: { edges: [
      { node: { titleText: { text: "B" }, series: { episodeNumber: { seasonNumber: 1, episodeNumber: 2 } } } },
      { node: { titleText: { text: "A" }, series: { episodeNumber: { seasonNumber: 1, episodeNumber: 1 } } } },
    ] } } } } };
    expect(parseEpisodes(json).map((e) => e.name)).toEqual(["A", "B"]);
    expect(sxxeyy(2, 5)).toBe("S02E05");
  });
});

describe("torrents", () => {
  test("a longer show with the same start is not the show", () => {
    expect(matchesShow("House.S01E01.720p", "House", "S01E01")).toBe(true);
    expect(matchesShow("House of the Dragon S01E01", "House", "S01E01")).toBe(false);
  });
  test("quality label and browser playability", () => {
    expect(qualityLabel("Fight.Club.1999.1080p.BluRay.x265-RARBG")).toBe("1080p x265 BluRay");
    expect(browserPlayable("Fight Club (1999) [1080p] [YTS.MX]")).toBe(true);
    expect(browserPlayable("Fight.Club.1999.1080p.x265.mp4")).toBe(false);
  });
  test("trackers are added once to a bare magnet", () => {
    const bare = "magnet:?xt=urn:btih:ABC123&dn=x";
    const full = withTrackers(bare);
    expect(full.match(/&tr=/g)?.length).toBe(4);
    expect(withTrackers(full)).toBe(full);
    expect(hashOf(bare)).toBe("abc123");
  });
});

describe("anime", () => {
  test("only an exact name counts as a match", () => {
    const anime = parseAnime({ title: { romaji: "Sousou no Frieren", english: "Frieren: Beyond Journey's End" }, episodes: 28 })!;
    expect(animeMatches(anime, "Frieren: Beyond Journey's End")).toBe(true);
    expect(animeMatches(anime, "Frieren")).toBe(false);
    expect(plainTitle("Sousou no Frieren 2nd Season")).toBe("Sousou no Frieren");
    expect(animeQueries(animeTitles(anime), 3, false)).toContain("Sousou no Frieren 03");
  });
});

describe("files and subtitles", () => {
  const files = [
    { index: 0, name: "Film/sample.mkv", bytes: 60_000_000 },
    { index: 1, name: "Film/Film.mp4", bytes: 900_000_000 },
    { index: 2, name: "Film/Film.es.srt", bytes: 100 },
    { index: 3, name: "Film/Film.en.srt", bytes: 100 },
  ];
  test("the film, not the sample; English subtitles first", () => {
    expect(pickVideos(files).map((f) => f.index)).toEqual([1]);
    expect(pickSubtitles(files)[0].index).toBe(3);
  });
  test("srt becomes WebVTT", () => {
    expect(srtToVtt("﻿1\r\n00:00:01,500 --> 00:00:03,250\r\nHi\r\n")).toBe("WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.250\nHi\n");
  });
  test("yify: the English row's link", () => {
    const html = '<tr><td class="sub-lang">Greek</td><a href="/subtitles/x-greek"></a></tr><tr><td class="sub-lang">English</td><a href="/subtitles/x-english"></a></tr>';
    expect(parseYifyEnglish(html)).toBe("x-english");
  });
  test("the browser page only adds a track when there are subtitles", () => {
    expect(playerPage("Film", false)).not.toContain("<track");
    expect(playerPage('Fi<lm"', true)).toContain('src="/subs.vtt"');
  });
});

describe("ui and arguments", () => {
  test("list window keeps the selection visible", () => {
    expect(windowOf(100, 0, 10)).toEqual([0, 10]);
    expect(windowOf(100, 50, 10)).toEqual([45, 55]);
    expect(windowOf(100, 99, 10)).toEqual([90, 100]);
  });
  test("source tags are short", () => {
    expect(sourceTag("The Pirate Bay")).toBe("TPB");
    expect(sourceTag("1337x")).toBe("1337x");
  });
  test("arguments", () => {
    expect(parseArgs(["--help"])).toBe("help");
    expect(parseArgs(["fight", "club", "--player", "mpv"])).toEqual({ query: "fight club", player: "mpv", dub: false, couch: false });
    expect(parseArgs(["couch", "before", "sunrise"])).toEqual({ query: "before sunrise", dub: false, couch: true });
    expect(parseArgs(["--engine"])).toEqual({ error: "--engine needs a value" });
    expect(parseArgs(["--nope"])).toEqual({ error: "unknown option --nope (see flick --help)" });
  });
});

describe("cache cap", () => {
  test("evicts the least recently watched first, never the one playing", () => {
    const dir = mkdtempSync(join(tmpdir(), "flick-cache-"));
    const mb = 1024 * 1024;
    const film = (name: string, megabytes: number, daysAgo: number) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "film.mp4"), Buffer.alloc(megabytes * mb));
      const when = new Date(Date.now() - daysAgo * 86_400_000);
      utimesSync(join(dir, name), when, when);
    };
    film("old", 3, 30);
    film("middle", 3, 10);
    film("playing", 3, 40); // oldest, but it's the one about to play
    const capGB = (6.5 * mb) / 1024 ** 3; // room for two of the three
    expect(trimCache(capGB, "playing", dir)).toEqual(["old"]);
    expect(readdirSync(dir).sort()).toEqual(["middle", "playing"]);
  });
});

describe("room", () => {
  const playingAt = (time: number, at: number) => ({ ...emptyState(), film: { id: "tt1", title: "Film" }, playing: true, time, at });
  test("a report that matches the room is an echo, not an action", () => {
    const s = playingAt(100, 0);
    expect(applySet(s, true, 110.5, 10_000)).toBeNull(); // room says 110, within 2 s
    expect(applySet(s, false, 110, 10_000)).toBe("pause");
    expect(applySet(s, false, 110, 11_000)).toBeNull(); // paused, same spot
    expect(applySet(s, false, 200, 11_000)).toBe("seek");
    expect(applySet(s, true, 200, 12_000)).toBe("play");
  });
  test("the room clock runs only while playing", () => {
    expect(currentTime(playingAt(50, 1000), 3000)).toBe(52);
    expect(currentTime({ ...playingAt(50, 1000), playing: false }, 3000)).toBe(50);
  });
  test("nothing happens without a film, or after it ended", () => {
    expect(applySet(emptyState(), true, 0, 0)).toBeNull();
    expect(applySet({ ...playingAt(0, 0), ended: true }, false, 5, 0)).toBeNull();
  });
});
