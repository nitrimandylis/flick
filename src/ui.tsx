// The full-screen terminal UI, built with Ink (React for terminals).
// Screens: browse (search bar + list) -> episodes (shows only) -> sources -> playing.
// On a wide terminal the list sits on the left and a details pane on the right
// shows whatever is highlighted: the title, the episode, or the source.

import { Box, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import { animeQueries, animeTitles, findAnime, type Anime } from "./anime.ts";
import type { Couch } from "./couch.ts";
import type { Engine } from "./engines.ts";
import type { PlayerName } from "./players.ts";
import { loadPoster, placeholderLines, posterId, POSTER_COLS, POSTER_ROWS, POSTERS } from "./poster.ts";
import { currentTime } from "./room.ts";
import { loadHistory, type Watched } from "./store.ts";
import { details, episodes, isSeries, searchTitles, seasons, sxxeyy, trending, type Details, type Episode, type Title } from "./titles.ts";
import {
  audioLabel,
  browserPlayable,
  findSources,
  hashOf,
  humanSize,
  magnetFromHash,
  parseQuality,
  pickBest,
  qualityGroups,
  qualityLabel,
  type Site,
  type SourceReport,
  type Torrent,
  type Wanted,
} from "./torrents.ts";
import { watch, type Progress, type Session } from "./watch.ts";

const C = {
  accent: "#3DF5FF", // couch's cyan, the same as the room page
  text: "#E8F1F5",
  mute: "#7D8A9A",
  good: "#86D6A2",
  warn: "#F0C560",
  bad: "#FF3DCB",
};

const LOGO = [" █▀▀ █   █ █▀▀ █▄▀", " █▀  █▄▄ █ █▄▄ █ █"];

const SOURCE_COLOR: Record<string, string> = { YTS: C.good, EZTV: C.warn, TPB: "#5FD0C5", Nyaa: "#D8B4FE" };

// Below this many columns there is no room for the details pane.
const WIDE = 100;

// Lists mix headings (skipped by the arrows) with rows.
type Heading = { heading: string };
type TitleRow = { title: Title; note: string };
type SourceRow = { torrent: Torrent; pick: boolean };
type BrowseEntry = Heading | TitleRow;
type SourceEntry = Heading | SourceRow;

type Screen =
  | { kind: "browse" }
  | { kind: "episodes"; title: Title; anime: Anime | null; seasons: number[]; season: number; list: Episode[] }
  | { kind: "sources"; wanted: Wanted; label: string; episodeTag?: string; report: SourceReport | null; hidden: number }
  | { kind: "playing"; label: string; title: Title | null; torrent: Torrent; status: string; progress: Progress | null; error: string | null };

export function App(props: { engine: Engine; player: PlayerName; cacheGB: number; dub: boolean; initialQuery: string; couch?: Couch }) {
  const { exit } = useApp();
  const { rows: height, columns: width } = useWindowSize();
  const [query, setQuery] = useState(props.initialQuery);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [selected, setSelected] = useState(0);
  const [screen, setScreen] = useState<Screen>({ kind: "browse" });
  const [busy, setBusy] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const session = useRef<Session | null>(null);
  const searchId = useRef(0);
  const sourcesId = useRef(0);
  const moved = useRef(false); // has the person moved the cursor on this sources list?
  const selectedHash = useRef(""); // the source under the cursor, kept while the list fills in
  const uploads = useRef<[number, number][]>([]); // couch: [time, bytes sent] every 2 s
  const couch = props.couch;
  const [, redraw] = useState(0);

  // couch mode: redraw when the room changes (tunnel up, someone joins, bytes
  // sent), and sample what's been sent, for the upload speed.
  useEffect(() => {
    if (!couch) return;
    couch.onUpdate = () => redraw((n) => n + 1);
    const timer = setInterval(() => {
      const now = Date.now();
      uploads.current = [...uploads.current, [now, couch.room.sentBytes] as [number, number]].filter(([at]) => now - at <= 30_000);
      redraw((n) => n + 1);
    }, 2000);
    return () => clearInterval(timer);
  }, [couch]);

  // ---------- loading lists ----------

  // Empty search: continue watching, then what's trending. Otherwise: search IMDb.
  useEffect(() => {
    const id = ++searchId.current;
    const timer = setTimeout(async () => {
      if (!query.trim()) {
        const history = loadHistory();
        showEntries(homeEntries(history, [], []));
        setBusy("loading what's trending…");
        const [films, shows] = await Promise.all([trending("movie"), trending("tvSeries")]);
        if (id !== searchId.current) return;
        showEntries(homeEntries(history, films, shows));
        setBusy("");
        return;
      }
      setBusy("searching…");
      const found = await searchTitles(query);
      if (id !== searchId.current) return;
      setEntries(found.map((title) => ({ title, note: "" })));
      setSelected(0);
      setBusy("");
    }, 250); // wait for typing to pause
    return () => clearTimeout(timer);
  }, [query]);

  // Swap the list in, moving the cursor off a heading if it landed on one.
  function showEntries(next: BrowseEntry[]) {
    setEntries(next);
    setSelected((i) => (next[i] && !("heading" in next[i]) ? i : firstRow(next)));
  }

  async function openTitle(title: Title) {
    if (couch && isSeries(title)) {
      setBusy("couch plays films only: TV releases are rarely files every browser can play");
      setTimeout(() => setBusy(""), 3500);
      return;
    }
    if (!isSeries(title)) return openSources({ kind: "film", title }, `${title.name}${title.year ? ` (${title.year})` : ""}`);
    setBusy(`loading ${title.name}…`);
    const anime = await findAnime(title.name);
    if (anime) {
      const list = Array.from({ length: anime.episodes }, (_, i) => ({
        season: 1,
        number: i + 1,
        name: anime.episodeNames[i + 1] ?? "",
        plot: "",
        date: "",
        minutes: 0,
      }));
      setScreen({ kind: "episodes", title, anime, seasons: [1], season: 1, list });
    } else {
      const all = await seasons(title.id);
      const last = loadHistory().find((w) => w.id === title.id);
      const season = last?.season && all.includes(last.season) ? last.season : (all[0] ?? 1);
      setScreen({ kind: "episodes", title, anime: null, seasons: all, season, list: await episodes(title.id, season) });
    }
    setSelected(resumeIndex(title.id));
    setBusy("");
  }

  async function openSources(wanted: Wanted, label: string, episodeTag?: string) {
    const id = ++sourcesId.current;
    moved.current = false;
    setScreen({ kind: "sources", wanted, label, episodeTag, report: null, hidden: 0 });
    setSelected(0);
    // Each site's answer is shown as it arrives.
    await findSources(wanted, (report) => {
      if (id !== sourcesId.current) return; // they already left this list
      // couch: only files every browser plays (MP4 with H.264)
      const torrents = couch ? report.torrents.filter((t) => browserPlayable(t.name)) : report.torrents;
      const next = sourceEntries(torrents);
      setScreen((s) => (s.kind === "sources" ? { ...s, report: { ...report, torrents }, hidden: report.torrents.length - torrents.length } : s));
      // The cursor starts on the pick; once they've moved, it stays on their source.
      const keep = moved.current ? next.findIndex((e) => "torrent" in e && e.torrent.infoHash === selectedHash.current) : -1;
      setSelected(keep >= 0 ? keep : firstRow(next));
    });
  }

  async function startWatching(torrent: Torrent, title: Title | null, label: string, episode?: { season: number; number: number; tag: string }) {
    setScreen({ kind: "playing", label, title, torrent, status: "starting…", progress: null, error: null });
    const update = (change: Partial<Extract<Screen, { kind: "playing" }>>) =>
      setScreen((s) => (s.kind === "playing" ? { ...s, ...change } : s));
    if (couch) {
      if (!title) return update({ error: "couch needs a film picked from search (it shows its details at the end)" });
      try {
        await couch.play(props.engine, title, torrent, (status) => update({ status }));
        const timer = setInterval(async () => {
          const progress = await couch.progress();
          if (progress) update({ progress });
          else clearInterval(timer);
        }, 2000);
      } catch (error) {
        update({ error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    try {
      const current = await watch({
        title,
        name: label,
        episode,
        torrent,
        engine: props.engine,
        player: props.player,
        cacheGB: props.cacheGB,
        onStatus: (status) => update({ status }),
        onProgress: (progress) => update({ progress }),
      });
      session.current = current;
      await current.closed;
      session.current = null;
      setScreen({ kind: "browse" });
      setQuery("");
    } catch (error) {
      update({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  // A magnet pasted anywhere plays straight away.
  usePaste((text) => {
    const hash = hashOf(text.trim());
    if (!hash || screen.kind === "playing") {
      if (screen.kind === "browse") setQuery((q) => q + text.replace(/\s+/g, " "));
      return;
    }
    const name = decodeURIComponent(text.match(/[?&]dn=([^&]+)/)?.[1] ?? "pasted magnet").replace(/\+/g, " ");
    const magnet = text.startsWith("magnet:") ? text.trim() : magnetFromHash(hash, name);
    startWatching({ name, infoHash: hash, magnet, seeders: 0, bytes: 0, source: "pasted" }, null, name);
  });

  // ---------- keys ----------

  const sourceList = screen.kind === "sources" && screen.report ? sourceEntries(screen.report.torrents) : [];
  const picked = sourceList[selected];
  selectedHash.current = picked && "torrent" in picked ? picked.torrent.infoHash : "";

  useInput((input, key) => {
    if (key.ctrl && input === "c") return quit();
    if (showHelp) return setShowHelp(false);

    if (screen.kind === "playing") {
      if (input === "c" && couch?.link) {
        copyToClipboard(couch.link);
        setBusy("room link copied");
        setTimeout(() => setBusy(""), 2000);
        return;
      }
      if (key.escape || input === "q" || key.return) {
        if (couch) {
          couch.stopFilm(); // the room keeps its place; the torrent stops
          setScreen({ kind: "browse" });
        } else if (session.current) session.current.stop();
        else setScreen({ kind: "browse" }); // it failed to start: go back
      }
      return;
    }

    if (key.upArrow || key.downArrow) {
      const step = key.upArrow ? -1 : 1;
      if (screen.kind === "browse") return setSelected((i) => nextRow(entries, i, step));
      if (screen.kind === "sources") {
        moved.current = true;
        return setSelected((i) => nextRow(sourceList, i, step));
      }
      if (screen.kind === "episodes") return setSelected((i) => Math.max(0, Math.min(screen.list.length - 1, i + step)));
    }

    if (screen.kind === "browse") {
      const entry = entries[selected];
      if (key.return && entry && "title" in entry) return void openTitle(entry.title);
      if (key.escape) return query ? setQuery("") : quit();
      if (key.backspace || key.delete) return setQuery((q) => q.slice(0, -1));
      if (input === "?" && !query) return setShowHelp(true);
      if (input && !key.ctrl && !key.meta) return setQuery((q) => q + input);
      return;
    }

    if (key.escape || input === "q") {
      sourcesId.current++; // a search still answering must not pull us back
      setSelected(0);
      return setScreen({ kind: "browse" });
    }
    if (input === "?") return setShowHelp(true);

    if (screen.kind === "episodes") {
      const at = screen.seasons.indexOf(screen.season);
      const step = key.leftArrow ? -1 : key.rightArrow ? 1 : 0;
      const next = screen.seasons[at + step];
      if (step && next !== undefined) {
        episodes(screen.title.id, next).then((list) => setScreen({ ...screen, season: next, list }));
        return setSelected(0);
      }
      const ep = screen.list[selected];
      if (key.return && ep) {
        const tag = sxxeyy(ep.season, ep.number);
        const label = `${screen.title.name} ${screen.anime ? `episode ${ep.number}` : tag}`;
        const wanted: Wanted = screen.anime
          ? { kind: "anime", title: screen.title, queries: animeQueries(animeTitles(screen.anime), ep.number, props.dub) }
          : { kind: "episode", title: screen.title, season: ep.season, episode: ep.number };
        return void openSources(wanted, label, tag);
      }
      return;
    }

    if (screen.kind === "sources" && key.return && picked && "torrent" in picked) {
      const ep = screen.wanted.kind === "episode" ? { season: screen.wanted.season, number: screen.wanted.episode, tag: screen.episodeTag ?? "" } : undefined;
      const animeEp = screen.wanted.kind === "anime" && screen.episodeTag ? { season: 1, number: Number(screen.episodeTag.slice(4)), tag: screen.episodeTag } : undefined;
      return void startWatching(picked.torrent, screen.wanted.title, screen.label, ep ?? animeEp);
    }
  });

  function resumeIndex(id: string): number {
    const last = loadHistory().find((w) => w.id === id);
    return last?.episode ? Math.max(0, last.episode) : 0; // the episode after the last one played
  }

  async function quit() {
    session.current?.stop();
    await couch?.close(); // the tunnel and the room go with flick
    await props.engine.shutdown(); // no torrent keeps seeding after flick closes
    exit();
  }

  // ---------- drawing ----------

  const home = screen.kind === "browse";
  const wide = width >= WIDE;
  const listWidth = Math.floor((width - 2) * 0.45);
  const listHeight = Math.max(5, height - (home ? 10 : 8));
  const footer =
    screen.kind === "browse"
      ? "type to search · ↑↓ move · ⏎ open · paste a magnet to play it · esc clear/quit · ? help"
      : screen.kind === "episodes"
        ? "←→ season · ↑↓ episode · ⏎ sources · esc back"
        : screen.kind === "sources"
          ? couch
            ? "↑↓ move · ⏎ put it on in the room · esc back"
            : "↑↓ move · ⏎ play · esc back"
          : couch
            ? "c copies the room link · esc takes the film off (the room keeps its place)"
            : "⏎ or esc stops the film";

  let list = null;
  let pane = null;
  if (screen.kind === "browse") {
    list = <TitleList entries={entries} selected={selected} height={listHeight} />;
    const entry = entries[selected];
    pane = entry && "title" in entry ? <TitlePane title={entry.title} /> : null;
  } else if (screen.kind === "episodes") {
    list = <EpisodeList screen={screen} selected={selected} height={listHeight} />;
    const ep = screen.list[selected];
    pane = ep ? <EpisodePane show={screen.title} episode={ep} anime={Boolean(screen.anime)} /> : null;
  } else if (screen.kind === "sources") {
    list = <SourceList screen={screen} entries={sourceList} selected={selected} height={listHeight} couch={Boolean(couch)} />;
    pane = picked && "torrent" in picked ? <SourcePane torrent={picked.torrent} pick={picked.pick} poster={screen.wanted.title.poster} couch={Boolean(couch)} /> : null;
  }

  return (
    <Box flexDirection="column" paddingX={1} height={height}>
      <Header home={home} couch={couch} engine={props.engine.name} player={props.player} />

      <Box marginTop={1} borderStyle="round" borderColor={home ? C.accent : C.mute} paddingX={1}>
        <Text color={C.accent}>⌕ </Text>
        {home ? (
          query ? <Text color={C.text}>{query}<Text color={C.accent}>▌</Text></Text> : <Text color={C.mute}>search films and shows, or paste a magnet</Text>
        ) : (
          <Text color={C.text}>{screen.kind === "episodes" ? screen.title.name : screen.label}</Text>
        )}
      </Box>

      <Box marginTop={1} flexGrow={1}>
        {showHelp ? (
          <Help />
        ) : screen.kind === "playing" ? (
          <Playing screen={screen} couch={couch} upload={uploadRate(uploads.current)} />
        ) : (
          <>
            <Box flexDirection="column" width={wide ? listWidth : undefined} flexGrow={wide ? 0 : 1} flexShrink={0} height={listHeight} overflow="hidden">
              {list}
            </Box>
            {wide ? (
              <Box flexDirection="column" flexGrow={1} marginLeft={3} height={listHeight} overflow="hidden">
                {pane}
              </Box>
            ) : null}
          </>
        )}
      </Box>

      <Box>
        <Text color={busy ? C.accent : C.mute} wrap="truncate">
          {busy || footer}
        </Text>
      </Box>
    </Box>
  );
}

// ---------- pure helpers (tested) ----------

/** The slice of a long list that fits, keeping the selection visible. Pure. */
export function windowOf(length: number, selected: number, height: number): [number, number] {
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), length - height));
  return [start, Math.min(length, start + height)];
}

/** The next row up or down from `from`, stepping over headings. Stays put at
 *  either end. Pure. */
export function nextRow(entries: object[], from: number, step: number): number {
  let i = from + step;
  while (i >= 0 && i < entries.length && "heading" in entries[i]) i += step;
  return i >= 0 && i < entries.length ? i : from;
}

/** The first row that isn't a heading (0 for an empty list). Pure. */
export function firstRow(entries: object[]): number {
  return Math.max(0, entries.findIndex((e) => !("heading" in e)));
}

/** Home: what you were watching, then what's trending. Pure. */
export function homeEntries(history: Watched[], films: Title[], shows: Title[]): BrowseEntry[] {
  const entries: BrowseEntry[] = [];
  if (history.length) entries.push({ heading: "Continue watching" });
  for (const w of history) {
    const title: Title = { id: w.id, name: w.name, year: w.year, kind: w.kind, poster: w.poster, cast: "" };
    entries.push({ title, note: w.episode ? `${sxxeyy(w.season ?? 1, w.episode + 1)} next` : "watched" });
  }
  if (films.length) entries.push({ heading: "Trending films" });
  for (const title of films) entries.push({ title, note: "" });
  if (shows.length) entries.push({ heading: "Trending shows" });
  for (const title of shows) entries.push({ title, note: "" });
  return entries;
}

/** Sources as the list shows them: flick's pick on top, then the rest grouped
 *  by resolution. Pure. */
export function sourceEntries(torrents: Torrent[]): SourceEntry[] {
  const pick = pickBest(torrents);
  const entries: SourceEntry[] = [];
  if (pick) entries.push({ heading: "best pick" }, { torrent: pick, pick: true });
  for (const group of qualityGroups(torrents.filter((t) => t !== pick))) {
    entries.push({ heading: `${group.label} · ${group.torrents.length}` });
    for (const torrent of group.torrents) entries.push({ torrent, pick: false });
  }
  return entries;
}

/** A short tag for a source: Knaben passes through tracker names like "The Pirate Bay". Pure. */
export function sourceTag(source: string): string {
  if (/pirate/i.test(source)) return "TPB";
  if (/^yts|yify/i.test(source)) return "YTS";
  if (/eztv/i.test(source)) return "EZTV";
  if (/nyaa/i.test(source)) return "Nyaa";
  return source.replace(/\s+/g, "").slice(0, 6);
}

/** "1:02:13", or "12:05" under an hour. Pure. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** A progress bar `width` characters wide. Pure. */
export function bar(fraction: number, width: number): string {
  const full = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return "█".repeat(full) + "░".repeat(width - full);
}

/** Bytes per second sent to the room over the samples' span, or null if
 *  there aren't two samples yet. Pure. */
export function uploadRate(samples: [number, number][]): number | null {
  if (samples.length < 2) return null;
  const [t0, b0] = samples[0];
  const [t1, b1] = samples[samples.length - 1];
  return t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : null;
}

/** Put text on the clipboard through the terminal (OSC 52): works over SSH and
 *  on any OS, no clipboard program needed. */
function copyToClipboard(text: string) {
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
}

// ---------- data for the panes ----------

const detailsCache = new Map<string, Details>();

/** A title's details, fetched once it has stayed highlighted for a moment. */
function useDetails(id: string | null): Details | null {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!id || detailsCache.has(id)) return;
    const timer = setTimeout(() => {
      details(id).then((d) => {
        detailsCache.set(id, d);
        bump((n) => n + 1);
      });
    }, 150); // scrolling past a row doesn't fetch it
    return () => clearTimeout(timer);
  }, [id]);
  return id ? (detailsCache.get(id) ?? null) : null;
}

// ---------- pieces ----------

function Header({ home, couch, engine, player }: { home: boolean; couch?: Couch; engine: string; player: string }) {
  const right = couch ? (
    <Box flexDirection="column" alignItems="flex-end">
      <Text color={couch.error ? C.bad : C.accent}>
        {couch.error ? `couch: ${couch.error}` : couch.link ? couch.link : "couch · opening the room…"}
      </Text>
      {home ? (
        <Text color={C.mute}>
          {couch.room.people().length ? `in the room: ${couch.room.people().join(", ")}` : "nobody in the room yet"} · {engine}
        </Text>
      ) : null}
    </Box>
  ) : (
    <Text color={C.mute}>
      {engine} · {player}
    </Text>
  );
  return (
    <Box justifyContent="space-between">
      {home ? (
        <Box flexDirection="column">
          {LOGO.map((line) => (
            <Text key={line} color={C.accent}>
              {line}
            </Text>
          ))}
        </Box>
      ) : (
        <Text color={C.accent} bold>
          flick
        </Text>
      )}
      {right}
    </Box>
  );
}

function Pointer({ on }: { on: boolean }) {
  return <Text color={C.accent}>{on ? "❯ " : "  "}</Text>;
}

// One line, like every row, so a list's window can count entries as lines.
function SectionHeading({ text }: { text: string }) {
  return (
    <Box flexShrink={0}>
      <Text color={C.mute} wrap="truncate">
        {"  ── "}
        {text}
      </Text>
    </Box>
  );
}

/** The poster, or the space it will fill once it has loaded. Nothing at all in
 *  terminals that can't show pictures. */
function Poster({ url }: { url: string }) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!POSTERS || !url || posterId(url)) return;
    const timer = setTimeout(() => loadPoster(url).then(() => bump((n) => n + 1)), 150);
    return () => clearTimeout(timer);
  }, [url]);
  if (!POSTERS) return null;
  const id = url ? posterId(url) : null;
  return (
    <Box flexDirection="column" width={POSTER_COLS} height={POSTER_ROWS} flexShrink={0} marginRight={2}>
      {id ? placeholderLines(id, POSTER_COLS, POSTER_ROWS).map((line, i) => <Text key={i}>{line}</Text>) : <Text color={C.mute}>{url ? "" : "no poster"}</Text>}
    </Box>
  );
}

function TitleList({ entries, selected, height }: { entries: BrowseEntry[]; selected: number; height: number }) {
  if (!entries.length) return <Text color={C.mute}>Nothing yet. Start typing.</Text>;
  const [from, to] = windowOf(entries.length, selected, height);
  return (
    <Box flexDirection="column">
      {entries.slice(from, to).map((entry, i) => {
        if ("heading" in entry) return <SectionHeading key={entry.heading} text={entry.heading} />;
        const on = from + i === selected;
        const t = entry.title;
        return (
          <Box key={t.id + entry.note} flexShrink={0}>
            <Pointer on={on} />
            <Text wrap="truncate">
              <Text color={on ? "#FFFFFF" : C.text} bold={on}>
                {t.name}
              </Text>
              <Text color={C.mute}>
                {t.year ? `  ${t.year}` : ""}
                {isSeries(t) ? "  show" : ""}
                {entry.note ? `  ${entry.note}` : ""}
              </Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function TitlePane({ title }: { title: Title }) {
  const d = useDetails(title.id);
  const facts = [title.year, isSeries(title) ? "series" : null, d?.minutes ? `${d.minutes} min` : null, d?.genres.join(", ")].filter(Boolean);
  return (
    <Box flexShrink={0}>
      <Poster url={title.poster} />
      <Box flexDirection="column" flexGrow={1}>
        <Text color={C.text} bold>
          {title.name}
        </Text>
        <Text color={C.mute}>{facts.join(" · ")}</Text>
        {d?.directors.length ? (
          <Box marginTop={1}>
            <Text color={C.mute}>directed by </Text>
            <Text color={C.text}>{d.directors.join(", ")}</Text>
          </Box>
        ) : null}
        {d?.cast.length ? (
          <Box>
            <Text color={C.mute}>with </Text>
            <Text color={C.text}>{d.cast.join(", ")}</Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text color={C.text}>{d ? d.plot || "IMDb has no plot for this one." : ""}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function EpisodeList({ screen, selected, height }: { screen: Extract<Screen, { kind: "episodes" }>; selected: number; height: number }) {
  const seen = new Set(loadHistory().find((w) => w.id === screen.title.id)?.seen ?? []);
  const [from, to] = windowOf(screen.list.length, selected, height - 2);
  return (
    <Box flexDirection="column">
      <Text color={C.mute}>
        {screen.anime ? `${screen.anime.romaji} · ${screen.anime.episodes} episodes` : screen.seasons.map((s) => (s === screen.season ? `[season ${s}]` : `${s}`)).join("  ")}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {screen.list.slice(from, to).map((ep, i) => {
          const on = from + i === selected;
          const tag = sxxeyy(ep.season, ep.number);
          return (
            <Box key={tag} flexShrink={0}>
              <Pointer on={on} />
              <Text wrap="truncate">
                <Text color={C.mute}>{screen.anime ? String(ep.number).padStart(3) : tag} </Text>
                <Text color={seen.has(tag) ? C.good : C.mute}>{seen.has(tag) ? "✓ " : "  "}</Text>
                <Text color={on ? "#FFFFFF" : C.text} bold={on}>
                  {ep.name || `Episode ${ep.number}`}
                </Text>
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function EpisodePane({ show, episode, anime }: { show: Title; episode: Episode; anime: boolean }) {
  const facts = [episode.date, episode.minutes ? `${episode.minutes} min` : null].filter(Boolean);
  return (
    <Box flexShrink={0}>
      <Poster url={show.poster} />
      <Box flexDirection="column" flexGrow={1}>
        <Text color={C.mute}>{anime ? `episode ${episode.number}` : sxxeyy(episode.season, episode.number)}</Text>
        <Text color={C.text} bold>
          {episode.name || `Episode ${episode.number}`}
        </Text>
        {facts.length ? <Text color={C.mute}>{facts.join(" · ")}</Text> : null}
        {episode.plot ? (
          <Box marginTop={1}>
            <Text color={C.text}>{episode.plot}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function SiteLine({ sites, hidden }: { sites: Site[]; hidden: number }) {
  return (
    <Text wrap="truncate">
      {sites.map((site, i) => (
        <Text key={site.name}>
          {i ? <Text color={C.mute}> · </Text> : null}
          <Text color={C.text}>{site.name} </Text>
          {site.state === "asking" ? <Text color={C.accent}>…</Text> : null}
          {site.state === "done" ? <Text color={C.good}>✓ {site.found}</Text> : null}
          {site.state === "offline" ? <Text color={C.bad}>✗ offline</Text> : null}
        </Text>
      ))}
      {hidden ? <Text color={C.mute}>{`  ·  ${hidden} hidden: not MP4`}</Text> : null}
    </Text>
  );
}

function SourceList({
  screen,
  entries,
  selected,
  height,
  couch,
}: {
  screen: Extract<Screen, { kind: "sources" }>;
  entries: SourceEntry[];
  selected: number;
  height: number;
  couch: boolean;
}) {
  const report = screen.report;
  const asking = !report || report.sites.some((s) => s.state === "asking");
  const [from, to] = windowOf(entries.length, selected, height - 1); // the site line takes one
  return (
    <Box flexDirection="column">
      {report ? <SiteLine sites={report.sites} hidden={screen.hidden} /> : <Text color={C.accent}>asking the sites…</Text>}
      {!entries.length && !asking ? (
        <Box marginTop={1}>
          <Text color={C.warn}>
            {couch ? "No release every browser can play (MP4, H.264) for this one; plain flick still plays it. " : ""}No sources found.
          </Text>
        </Box>
      ) : null}
      {entries.slice(from, to).map((entry, i) => {
        if ("heading" in entry) return <SectionHeading key={entry.heading} text={entry.heading} />;
        const on = from + i === selected;
        const t = entry.torrent;
        const tag = sourceTag(t.source);
        return (
          <Box key={t.infoHash + (entry.pick ? "pick" : "")} flexShrink={0}>
            <Pointer on={on} />
            <Text wrap="truncate">
              <Text color={t.seeders > 20 ? C.good : t.seeders > 0 ? C.warn : C.bad}>{String(t.seeders).padStart(5)}▲ </Text>
              <Text color={C.mute}>{humanSize(t.bytes).padStart(8)} </Text>
              <Text color={on ? "#FFFFFF" : C.text} bold={on}>
                {" "}
                {qualityLabel(t.name).slice(0, 22).padEnd(23)}
              </Text>
              <Text color={SOURCE_COLOR[tag] ?? C.mute}>{tag}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function SourcePane({ torrent, pick, poster, couch }: { torrent: Torrent; pick: boolean; poster: string; couch: boolean }) {
  const q = parseQuality(torrent.name);
  const audio = audioLabel(torrent.name);
  const playable = browserPlayable(torrent.name);
  return (
    <Box flexShrink={0}>
      <Poster url={poster} />
      <Box flexDirection="column" flexGrow={1}>
        <Text color={C.text} bold>
          {torrent.name}
        </Text>
        <Box marginTop={1}>
          <Text color={C.mute}>
            {humanSize(torrent.bytes)} · {torrent.seeders} seeders · {sourceTag(torrent.source)}
          </Text>
        </Box>
        <Text color={C.text}>{[q.res, q.hdr, q.codec, q.src].filter(Boolean).join(" · ") || "quality not in the name"}</Text>
        {audio ? <Text color={C.text}>audio {audio}</Text> : null}
        {couch ? null : (
          <Box marginTop={1}>
            <Text color={playable ? C.good : C.mute}>{playable ? "works in flick couch (MP4 H.264)" : "not for flick couch: browsers can't play it"}</Text>
          </Box>
        )}
        {pick ? (
          <Box marginTop={1}>
            <Text color={C.accent}>flick's pick: 1080p x264 under 6 GB, the most seeders</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function Playing({ screen, couch, upload }: { screen: Extract<Screen, { kind: "playing" }>; couch?: Couch; upload: number | null }) {
  const d = useDetails(screen.title?.id ?? null);
  const p = screen.progress;
  return (
    <Box flexShrink={0}>
      {screen.title ? <Poster url={screen.title.poster} /> : null}
      <Box flexDirection="column" flexGrow={1}>
        <Text color={C.text} bold>
          {screen.label}
        </Text>
        {screen.error ? <Text color={C.bad}>✗ {screen.error}</Text> : <Text color={C.accent}>● {screen.status}</Text>}
        {p ? (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text color={C.accent}>{bar(p.percent / 100, 30)}</Text>
              <Text color={C.text}> {p.percent >= 100 ? "downloaded" : `${p.percent}%`}</Text>
            </Text>
            <Text color={C.mute}>
              {p.percent < 100 ? `↓ ${humanSize(p.downBytesPerSec)}/s · ` : ""}
              {p.peers} {p.peers === 1 ? "peer" : "peers"}
            </Text>
          </Box>
        ) : null}
        {couch && !screen.error ? <RoomCard couch={couch} torrent={screen.torrent} minutes={d?.minutes ?? 0} upload={upload} /> : null}
      </Box>
    </Box>
  );
}

/** couch: who's there, where the room is, and whether this computer's upload
 *  keeps up with the film. */
function RoomCard({ couch, torrent, minutes, upload }: { couch: Couch; torrent: Torrent; minutes: number; upload: number | null }) {
  const people = couch.room.people();
  const s = couch.room.state;
  const at = clock(currentTime(s));
  const last = couch.room.lastChange;
  const position = !s.src
    ? "waiting for the film…"
    : s.playing
      ? `▶ ${at}`
      : `❚❚ ${last?.action === "pause" ? `paused by ${last.by} at` : "paused at"} ${at}`;

  // The film's bitrate times the people watching (the host streams from the
  // room too) is what the upload has to keep up with.
  const bitrate = torrent.bytes && minutes ? torrent.bytes / (minutes * 60) : 0;
  const need = bitrate * people.length;
  let health = <Text color={C.mute}>upload idle</Text>;
  if (s.playing && people.length && upload !== null) {
    const ok = !need || upload >= need * 0.9;
    health = (
      <Text color={ok ? C.good : C.warn}>
        upload {humanSize(upload)}/s{need ? ` · the film needs ${humanSize(need)}/s` : ""} · {ok ? "keeping up" : "may buffer"}
      </Text>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={C.text}>{people.length ? `in the room: ${people.join(", ")}` : "nobody in the room yet"}</Text>
      <Text color={s.playing ? C.accent : C.text}>{position}</Text>
      {health}
      {couch.link ? (
        <Box marginTop={1}>
          <Text color={C.accent}>{couch.link}</Text>
          <Text color={C.mute}> · c copies it</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function Help() {
  const lines = [
    ["type", "search films and shows (IMDb)"],
    ["⏎", "open a title, an episode, or play a source"],
    ["↑ ↓", "move"],
    ["← →", "change season"],
    ["c", "couch: copy the room link while a film is on"],
    ["esc", "back, clear the search, or quit"],
    ["paste", "a magnet link or info hash plays it straight away"],
    ["ctrl+c", "quit; no torrent keeps uploading after flick closes"],
  ];
  return (
    <Box flexDirection="column">
      {lines.map(([k, v]) => (
        <Box key={k}>
          <Text color={C.accent}>{k.padEnd(8)}</Text>
          <Text color={C.text}>{v}</Text>
        </Box>
      ))}
      <Text color={C.mute}>any key closes this</Text>
    </Box>
  );
}
