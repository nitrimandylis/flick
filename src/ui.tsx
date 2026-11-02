// The full-screen terminal UI, built with Ink (React for terminals).
// It opens on a splash (the marquee, the search bar). Then: browse (programme
// tabs, the list, a details pane) -> episodes (shows only) -> sources -> playing.
// The cinema look's pieces live in look.tsx.

import { Box, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { animeQueries, animeTitles, findAnime, type Anime } from "./anime.ts";
import type { Couch } from "./couch.ts";
import type { Engine } from "./engines.ts";
import { Badge, C, FilmStrip, Hints, Marquee, Scrollbar, Spinner, spaced, type Hint } from "./look.tsx";
import type { PlayerName } from "./players.ts";
import { loadPoster, placeholderLines, posterEvents, posterId, posterSize, posterTint, POSTERS } from "./poster.ts";
import { currentTime } from "./room.ts";
import { loadHistory, type Watched } from "./store.ts";
import { details, episodes, isSeries, searchTitles, seasons, sxxeyy, trending, type Details, type Episode, type Title } from "./titles.ts";
import {
  audioLabel,
  browserPlayable,
  findSources,
  whyNotCouch,
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

// Resolution badges: 4K warm, 1080p cyan, 720p grey.
const RES_COLOR: Record<string, string> = { "2160p": "#FFB86B", "1080p": "#3DF5FF", "720p": "#7D8A9A", "480p": "#4A5A6E" };

/** "4K" for 2160p, "SD" when the name doesn't say. Pure. */
export function resolutionLabel(res: string): string {
  return res === "2160p" ? "4K" : res || "SD";
}

const SOURCE_COLOR: Record<string, string> = { YTS: C.good, EZTV: C.warn, TPB: "#6FC8FF", Nyaa: "#C9A7FF" };

// The home screen's sections, switched with tab, like a cinema programme.
const SECTIONS = ["Continue", "Now showing", "Shows"] as const;
type Section = (typeof SECTIONS)[number];

// The sources list mixes headings (skipped by the arrows) with sources.
type Heading = { heading: string };
type TitleRow = { title: Title; note: string };
type SourceRow = { torrent: Torrent; pick: boolean };
type SourceEntry = Heading | SourceRow;

type Screen =
  | { kind: "browse" }
  | { kind: "episodes"; title: Title; anime: Anime | null; seasons: number[]; season: number; list: Episode[] }
  | { kind: "sources"; wanted: Wanted; label: string; episodeTag?: string; report: SourceReport | null; hidden: number }
  | { kind: "playing"; label: string; title: Title | null; torrent: Torrent; status: string; progress: Progress | null; error: string | null };

export function App(props: { engine: Engine; player: PlayerName; cacheGB: number; dub: boolean; initialQuery: string; couch?: Couch }) {
  const { exit } = useApp();
  const { rows: height, columns: width } = useWindowSize();
  const [splash, setSplash] = useState(!props.initialQuery);
  const [query, setQuery] = useState(props.initialQuery);
  const [section, setSection] = useState<Section>("Continue");
  const [home, setHome] = useState<Record<Section, TitleRow[]>>({ Continue: [], "Now showing": [], Shows: [] });
  const [results, setResults] = useState<TitleRow[]>([]);
  const [selected, setSelected] = useState(0);
  const [screen, setScreen] = useState<Screen>({ kind: "browse" });
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "no" } | null>(null); // a short note at the bottom right
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [showHelp, setShowHelp] = useState(false);
  const session = useRef<Session | null>(null);
  const searchId = useRef(0);
  const sourcesId = useRef(0);
  const moved = useRef(false); // has the person moved the cursor on this sources list?
  const selectedHash = useRef(""); // the source under the cursor, kept while the list fills in
  const uploads = useRef<[number, number][]>([]); // couch: [time, bytes sent] every 2 s
  const couch = props.couch;
  const [, redraw] = useState(0);

  // "ok" confirms something; "no" explains why flick didn't do what was asked.
  function showToast(text: string, kind: "ok" | "no" = "ok") {
    setToast({ text, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }

  // A poster finished loading: redraw, so its colour reaches the titles.
  useEffect(() => {
    posterEvents.onReady = () => redraw((n) => n + 1);
  }, []);

  // couch mode: redraw when the room changes (tunnel up, someone joins, bytes
  // sent), say who came and went, and sample what's been sent, for the upload speed.
  useEffect(() => {
    if (!couch) return;
    let before = couch.room.people();
    couch.onUpdate = () => {
      const now = couch.room.people();
      for (const name of now) if (!before.includes(name)) showToast(`${name} joined`);
      for (const name of before) if (!now.includes(name)) showToast(`${name} left`);
      before = now;
      redraw((n) => n + 1);
    };
    const timer = setInterval(() => {
      const now = Date.now();
      uploads.current = [...uploads.current, [now, couch.room.sentBytes] as [number, number]].filter(([at]) => now - at <= 30_000);
      redraw((n) => n + 1);
    }, 2000);
    return () => clearInterval(timer);
  }, [couch]);

  // ---------- loading lists ----------

  // Home: what you were watching, and what's trending, loaded once.
  useEffect(() => {
    const history = continueRows(loadHistory());
    setHome((h) => ({ ...h, Continue: history }));
    if (!history.length) setSection("Now showing");
    Promise.all([trending("movie"), trending("tvSeries")]).then(([films, shows]) => {
      setHome((h) => ({ ...h, "Now showing": films.map((title) => ({ title, note: "" })), Shows: shows.map((title) => ({ title, note: "" })) }));
    });
  }, []);

  // Typing searches IMDb, once the typing pauses.
  useEffect(() => {
    const id = ++searchId.current;
    if (!query.trim()) return;
    const timer = setTimeout(async () => {
      setBusy("searching…");
      const found = await searchTitles(query);
      if (id !== searchId.current) return;
      setResults(found.map((title) => ({ title, note: "" })));
      setSelected(0);
      setBusy("");
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const rows = query.trim() ? results : home[section];

  async function openTitle(title: Title) {
    if (couch && isSeries(title)) {
      showToast("couch plays films only", "no");
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
    setSplash(false);
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
      if (screen.kind === "browse") {
        setSplash(false);
        setQuery((q) => q + text.replace(/\s+/g, " "));
      }
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

    if (splash) {
      if (key.return) {
        setSplash(false); // an empty search browses; a typed one shows its results
        return setSelected(0);
      }
      if (key.escape) return query ? setQuery("") : quit();
      if (key.backspace || key.delete) return setQuery((q) => q.slice(0, -1));
      if (input && !key.ctrl && !key.meta) {
        setSplash(false);
        return setQuery((q) => q + input);
      }
      return;
    }

    if (screen.kind === "playing") {
      if (input === "c" && couch?.link) {
        copyToClipboard(couch.link);
        showToast("room link copied");
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

    // browse: the poster wall moves with ←→ (and ↑↓ too)
    if (screen.kind === "browse" && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)) {
      const step = key.leftArrow || key.upArrow ? -1 : 1;
      return setSelected((i) => Math.max(0, Math.min(rows.length - 1, i + step)));
    }
    if (key.upArrow || key.downArrow) {
      const step = key.upArrow ? -1 : 1;
      if (screen.kind === "sources") {
        moved.current = true;
        return setSelected((i) => nextRow(sourceList, i, step));
      }
      if (screen.kind === "episodes") return setSelected((i) => Math.max(0, Math.min(screen.list.length - 1, i + step)));
    }

    if (screen.kind === "browse") {
      const row = rows[selected];
      if (key.tab) {
        // tab leaves a search and steps through the home sections
        const next = query ? section : SECTIONS[(SECTIONS.indexOf(section) + (key.shift ? SECTIONS.length - 1 : 1)) % SECTIONS.length];
        setQuery("");
        setSection(next);
        return setSelected(0);
      }
      if (key.return && row) return void openTitle(row.title);
      if (key.escape) {
        if (query) return setQuery("");
        return setSplash(true);
      }
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

  const searchText = query ? (
    <Text color={C.text}>
      {query}
      <Text color={C.accent}>▌</Text>
    </Text>
  ) : (
    <Text color={C.mute}>Search films and shows, or paste a magnet link…</Text>
  );

  if (splash && !showHelp) {
    const boxWidth = Math.min(76, width - 4);
    const nowShowing = home["Now showing"].slice(0, 3).map((row) => row.title.name);
    return (
      <Box flexDirection="column" height={height} alignItems="center" justifyContent="center">
        <Marquee chase />
        <Box marginTop={1} flexShrink={0}>
          <Text color={C.text}>Films and shows, streamed from torrents, played right away.</Text>
        </Box>
        <Box flexShrink={0} height={1}>
          <Text color={C.bulb}>{nowShowing.length ? "now showing  " : " "}</Text>
          <Text color={C.mute}>{nowShowing.join(" · ")}</Text>
        </Box>
        <Box marginTop={2} flexShrink={0} flexDirection="column" width={boxWidth}>
          <Text>
            <Text color={C.accent}>⌕ </Text>
            {searchText}
          </Text>
          <Text color={C.accent}>{"▔".repeat(boxWidth)}</Text>
        </Box>
        <Box marginTop={1}>
          <Hints hints={[["⏎", "search"], ["empty ⏎", "browse"], ["^c", "quit"]]} message={couch?.link ? `couch: ${couch.link}` : undefined} />
        </Box>
      </Box>
    );
  }

  const inner = width - 2;
  // The big poster's height grows with the terminal; the small ones are 3/5 of it.
  const big = posterSize(Math.max(8, Math.min(22, height - 19)));
  const small = posterSize(Math.round(big.rows * 0.6));
  const stageHeight = height - 5; // header 2, hints 2, a spare row

  const hints: Hint[] =
    screen.kind === "browse"
      ? [["←→", "browse"], ["⏎", "sources"], ["tab", "section"], ["type", "search"], ["esc", query ? "clear" : "home"]]
      : screen.kind === "episodes"
        ? [["↑↓", "episode"], ["←→", "season"], ["⏎", "sources"], ["esc", "back"]]
        : screen.kind === "sources"
          ? [["↑↓", "move"], ["⏎", couch ? "put it on in the room" : "play"], ["esc", "back"]]
          : couch
            ? [["c", "copy the room link"], ["esc", "take the film off"]]
            : [["esc", "stop"]];

  let body = null;
  if (showHelp) {
    body = <Help />;
  } else if (screen.kind === "browse") {
    const label = query.trim() ? (busy ? "searching…" : `${rows.length} results`) : `${rows.length} ${section === "Shows" ? "shows" : section === "Continue" ? "to continue" : "films"}`;
    body = <Lobby rows={rows} selected={selected} width={inner} big={big} small={small} label={label} empty={query.trim() ? "Nothing found." : "Loading…"} />;
  } else if (screen.kind === "episodes") {
    body = (
      <Stage poster={screen.title.poster} big={big}>
        <EpisodeList screen={screen} selected={selected} height={stageHeight} />
      </Stage>
    );
  } else if (screen.kind === "sources") {
    body = (
      <Stage poster={screen.wanted.title.poster} big={big}>
        <SourceList screen={screen} entries={sourceList} selected={selected} height={stageHeight} couch={Boolean(couch)} picked={picked} />
      </Stage>
    );
  } else {
    body = (
      <Stage poster={screen.title?.poster ?? ""} big={big}>
        <Playing screen={screen} couch={couch} upload={uploadRate(uploads.current)} barWidth={Math.min(60, inner - big.cols - 6)} />
      </Stage>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} height={height}>
      <Box justifyContent="space-between" flexShrink={0}>
        {screen.kind !== "browse" ? (
          <Text wrap="truncate">
            <Text color={C.accent} bold>
              flick
            </Text>
            {"   "}
            {trail(screen, query, section).map((part, i, all) => (
              <Text key={i}>
                {i ? <Text color={C.rule}>{" › "}</Text> : null}
                <Text color={i === all.length - 1 ? C.text : C.mute}>{part}</Text>
              </Text>
            ))}
          </Text>
        ) : (
        <Text wrap="truncate">
          <Text color={C.accent} bold>
            flick
          </Text>
          {"   "}
          {SECTIONS.map((name) => {
            const on = screen.kind === "browse" && !query.trim() && name === section;
            // the gap stays outside the underline
            return (
              <Text key={name}>
                <Text color={on ? C.accent : C.mute} bold={on} underline={on}>
                  {name.toLowerCase()}
                </Text>
                {"   "}
              </Text>
            );
          })}
        </Text>
        )}
        {screen.kind === "browse" ? (
          <Text>
            <Text color={C.accent}>⌕ </Text>
            {query ? (
              <Text color={C.text}>
                {query}
                <Text color={C.accent}>▌</Text>
              </Text>
            ) : (
              <Text color={C.mute}>type to search</Text>
            )}
          </Text>
        ) : null}
      </Box>

      <Box marginTop={1} flexGrow={1} flexDirection="column" overflow="hidden">
        {body}
      </Box>

      <Box justifyContent="space-between" flexShrink={0}>
        <Hints hints={hints} message={busy && screen.kind !== "browse" ? busy : undefined} />
        {toast ? (
          <Text backgroundColor={toast.kind === "ok" ? C.accent : C.warn} color={C.ink} bold>
            {` ${toast.kind === "ok" ? "✓" : "–"} ${toast.text} `}
          </Text>
        ) : width >= 100 || couch ? (
          <Status couch={couch} engine={props.engine.name} player={props.player} playing={screen.kind === "playing"} />
        ) : null}
      </Box>
    </Box>
  );
}

// ---------- pure helpers (tested) ----------

/** Where you are, for the header after browse: where you came from (the search
 *  or the section), then the title, then the season or episode. Pure. */
export function trail(screen: Screen, query: string, section: string): string[] {
  const from = query.trim() ? `⌕ ${query.trim()}` : section.toLowerCase();
  if (screen.kind === "episodes") return [from, screen.title.name, screen.anime ? "episodes" : `season ${screen.season}`];
  if (screen.kind === "sources") {
    if (screen.wanted.kind === "film") return [from, screen.label];
    return [from, screen.wanted.title.name, screen.episodeTag ?? "", "sources"].filter(Boolean);
  }
  if (screen.kind === "playing") return screen.title ? [from, screen.label] : ["pasted magnet", screen.label];
  return [from];
}

/** `text` word-wrapped to `width` columns, at most `lines` lines; if it runs
 *  longer, the last line ends in "…" instead of stopping mid-word. Pure. */
export function clip(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += " " + word;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  if (out.length <= lines) return out;
  const kept = out.slice(0, lines);
  const last = kept[lines - 1].slice(0, width - 1).replace(/[\s.,;:]+$/, "");
  kept[lines - 1] = last + "…";
  return kept;
}

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

/** "Continue watching": films you watched, shows with the next episode. Pure. */
export function continueRows(history: Watched[]): TitleRow[] {
  return history.map((w) => ({
    title: { id: w.id, name: w.name, year: w.year, kind: w.kind, poster: w.poster, cast: "" },
    note: w.episode ? `${sxxeyy(w.season ?? 1, w.episode + 1)} next` : "watched",
  }));
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

/** Top right: the room's link and who's in it, or the engine and player. */
/** Bottom right: the engine and player, or in couch mode who's in the room
 *  (or the link to send, while nobody is). One row. */
function Status({ couch, engine, player, playing }: { couch?: Couch; engine: string; player: string; playing: boolean }) {
  if (!couch) {
    return (
      <Text color={C.mute}>
        {engine} · {player}
      </Text>
    );
  }
  if (couch.error) return <Text color={C.bad}>couch: {couch.error}</Text>;
  const people = couch.room.people();
  // while a film is on, the room card has all of this
  const what = playing ? engine : people.length ? people.join(", ") : (couch.link ?? "opening the room…");
  return (
    <Text wrap="truncate">
      <Text color={C.bulb}>couch</Text>
      <Text color={C.mute}> · {what}</Text>
    </Text>
  );
}

function Pointer({ on }: { on: boolean }) {
  return <Text color={C.accent}>{on ? "▸ " : "  "}</Text>;
}

/** A column header row, dim, lined up with the rows below it. */
function Columns({ children }: { children: ReactNode }) {
  return (
    <Box flexShrink={0}>
      <Text color={C.mute} wrap="truncate">
        {children}
      </Text>
    </Box>
  );
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

type Size = { cols: number; rows: number };

/** A poster at `size` cells. Where the terminal can't show pictures it is a
 *  card with the title on it; while it loads, an empty card. */
function Poster({ url, size, name = "", on = false }: { url: string; size: Size; name?: string; on?: boolean }) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!POSTERS || !url || posterId(url, size.cols, size.rows)) return;
    const timer = setTimeout(() => loadPoster(url, size.cols, size.rows).then(() => bump((n) => n + 1)), 120);
    return () => clearTimeout(timer);
  }, [url, size.cols, size.rows]);
  const id = POSTERS && url ? posterId(url, size.cols, size.rows) : null;
  if (id) {
    return (
      <Box flexDirection="column" width={size.cols} height={size.rows} flexShrink={0}>
        {placeholderLines(id, size.cols, size.rows).map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
    );
  }
  return (
    <Box width={size.cols} height={size.rows} flexShrink={0} borderStyle="round" borderColor={on ? C.accent : C.rule} justifyContent="center" alignItems="center" paddingX={1}>
      <Box flexDirection="column" alignItems="center">
        {POSTERS ? null : clip(name, size.cols - 4, size.rows - 2).map((line, i) => (
          <Text key={i} color={on ? C.text : C.mute} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/** Browse: a wall of posters, the highlighted one big at the left, and what
 *  it is underneath. */
function Lobby({ rows, selected, width, big, small, label, empty }: { rows: TitleRow[]; selected: number; width: number; big: Size; small: Size; label: string; empty: string }) {
  const fit = Math.max(1, 1 + Math.floor((width - big.cols - 2) / (small.cols + 2)));
  if (!rows.length) {
    if (empty !== "Loading…") return <Text color={C.mute}>{empty}</Text>;
    // still loading: empty cards where the posters will be
    return (
      <Box flexDirection="column">
        <Text color={C.mute}>
          <Spinner /> loading what's on
        </Text>
        <Box marginTop={1}>
          {Array.from({ length: fit }, (_, i) => {
            const size = i === 0 ? big : small;
            return (
              <Box key={i} flexDirection="column" marginRight={2} flexShrink={0}>
                {i === 0 ? null : <Box height={big.rows - small.rows} />}
                <Box width={size.cols} height={size.rows} borderStyle="round" borderColor={C.rule} />
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  }
  // The shelf scrolls only when the cursor nears its edge; the big poster is
  // wherever the cursor is, so the posters around it stay put.
  const [from, to] = windowOf(rows.length, selected, fit);
  const shown = rows.slice(from, to);
  const row = rows[selected];
  return (
    <Box flexDirection="column">
      <Text color={C.mute}>
        {label}
        {"   "}
        <Text color={from > 0 ? C.accent : C.rule}>‹ </Text>
        <Text color={C.rule}>{`${selected + 1} of ${rows.length}`}</Text>
        <Text color={to < rows.length ? C.accent : C.rule}> ›</Text>
      </Text>
      <Box marginTop={1} flexShrink={0}>
        {shown.map((r, i) => {
          const on = from + i === selected;
          const size = on ? big : small;
          const name = clip(r.title.name, size.cols, 2);
          return (
            <Box key={r.title.id + r.note} flexDirection="column" width={size.cols} marginRight={2} flexShrink={0}>
              {on ? null : <Box height={big.rows - small.rows} flexShrink={0} />}
              <Poster url={r.title.poster} size={size} name={on ? r.title.name : ""} on={on} />
              {on ? (
                <Text color={tintOf(r.title.poster)}>{"▔".repeat(size.cols)}</Text>
              ) : (
                <>
                  <Text color={C.mute}>{name[0] ?? " "}</Text>
                  <Text color={C.mute}>{name[1] ?? " "}</Text>
                  <Text color={C.rule} wrap="truncate">
                    {r.title.year ?? ""}
                    {isSeries(r.title) ? " · series" : ""}
                  </Text>
                </>
              )}
            </Box>
          );
        })}
      </Box>
      <About title={row.title} note={row.note} width={width} />
    </Box>
  );
}

/** A poster's colour, or flick's cyan until the poster has loaded. */
function tintOf(poster: string): string {
  return (poster && posterTint(poster)) || C.accent;
}

/** A grey bar standing in for text that is still loading. */
function Skeleton({ width }: { width: number }) {
  return <Text color={C.rule}>{"━".repeat(Math.max(1, width))}</Text>;
}

/** The highlighted title: name, facts, people, plot. Grey bars until IMDb answers. */
function About({ title, note, width }: { title: Title; note: string; width: number }) {
  const d = useDetails(title.id);
  const facts = [title.year, d?.minutes ? `${d.minutes} min` : null, d?.genres.join(", ")].filter(Boolean);
  const box = Math.min(width, 110);
  return (
    <Box flexDirection="column" marginTop={1} width={box} flexShrink={0}>
      <Text wrap="truncate">
        <Text color={tintOf(title.poster)} bold>
          {title.name.toUpperCase()}
        </Text>
        {"   "}
        {isSeries(title) ? <Badge text="series" color={C.warn} /> : null}
        {isSeries(title) && note ? " " : null}
        {note ? <Badge text={note} color={C.good} /> : null}
      </Text>
      <Text color={C.mute} wrap="truncate">
        {facts.join(" · ")}
      </Text>
      {d ? (
        <>
          <Text wrap="truncate">
            <Text color={C.rule}>{spaced("director") + "   "}</Text>
            <Text color={C.text}>{d.directors.join(", ") || "-"}</Text>
          </Text>
          <Text wrap="truncate">
            <Text color={C.rule}>{spaced("cast") + "   "}</Text>
            <Text color={C.text}>{d.cast.join(", ") || "-"}</Text>
          </Text>
          <Box marginTop={1} flexDirection="column">
            {clip(d.plot, box, 2).map((line, i) => (
              <Text key={i} color={C.text} italic>
                {line}
              </Text>
            ))}
          </Box>
        </>
      ) : (
        <>
          <Skeleton width={24} />
          <Skeleton width={40} />
          <Box marginTop={1} flexDirection="column">
            <Skeleton width={box - 10} />
            <Skeleton width={Math.round(box * 0.6)} />
          </Box>
        </>
      )}
    </Box>
  );
}

/** Every screen after browse: the big poster at the left, the screen's own
 *  content beside it. Without pictures the content takes the whole width. */
function Stage({ poster, big, children }: { poster: string; big: Size; children: ReactNode }) {
  return (
    <Box flexShrink={0}>
      {POSTERS && poster ? (
        <Box marginRight={3} flexShrink={0}>
          <Poster url={poster} size={big} on />
        </Box>
      ) : null}
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}

function EpisodeList({ screen, selected, height }: { screen: Extract<Screen, { kind: "episodes" }>; selected: number; height: number }) {
  const last = loadHistory().find((w) => w.id === screen.title.id);
  const seen = new Set(last?.seen ?? []);
  // the episode after the last one played, if it is in this season
  const next = last?.episode && (last.season ?? 1) === screen.season ? last.episode + 1 : 0;
  const [from, to] = windowOf(screen.list.length, selected, Math.max(3, height - 9));
  const ep = screen.list[selected];
  return (
    <Box flexDirection="column">
      <Text color={tintOf(screen.title.poster)} bold wrap="truncate">
        {screen.title.name.toUpperCase()}
      </Text>
      <Text wrap="truncate">
        {screen.anime ? (
          <Text color={C.mute}>
            {screen.anime.romaji} · {screen.anime.episodes} episodes
          </Text>
        ) : (
          screen.seasons.map((s) => (
            <Text key={s}>
              <Text color={s === screen.season ? C.accent : C.mute} bold={s === screen.season} underline={s === screen.season}>
                {`season ${s}`}
              </Text>
              {"   "}
            </Text>
          ))
        )}
      </Text>
      <Box marginTop={1}>
      <Box flexDirection="column" width={64} flexShrink={1}>
        {screen.list.slice(from, to).map((e, i) => {
          const on = from + i === selected;
          const tag = sxxeyy(e.season, e.number);
          const when = [e.date, e.minutes ? `${e.minutes} min` : ""].filter(Boolean).join("   ");
          return (
            <Box key={tag} flexShrink={0}>
              <Pointer on={on} />
              <Box flexGrow={1} minWidth={0}>
                <Text wrap="truncate">
                  <Text color={C.mute}>{screen.anime ? String(e.number).padStart(3) : tag} </Text>
                  <Text color={seen.has(tag) ? C.good : C.mute}>{seen.has(tag) ? "✓ " : "  "}</Text>
                  <Text color={on ? C.accent : C.text} bold={on}>
                    {e.name || `Episode ${e.number}`}
                  </Text>
                  {e.number === next ? <Text color={C.good}>{"  ▸ next"}</Text> : null}
                </Text>
              </Box>
              <Text color={C.rule}>{when ? "  " + when : ""}</Text>
            </Box>
          );
        })}
      </Box>
      <Scrollbar total={screen.list.length} from={from} visible={to - from} height={to - from} />
      </Box>
      {ep ? (
        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          <Text color={C.text} bold wrap="truncate">
            {ep.name || `Episode ${ep.number}`}
          </Text>
          {clip(ep.plot, 64, 3).map((line, i) => (
            <Text key={i} color={C.mute} italic>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
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
          {site.state === "asking" ? <Spinner /> : null}
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
  picked,
}: {
  screen: Extract<Screen, { kind: "sources" }>;
  entries: SourceEntry[];
  selected: number;
  height: number;
  couch: boolean;
  picked: SourceEntry | undefined;
}) {
  const report = screen.report;
  const asking = !report || report.sites.some((s) => s.state === "asking");
  const [from, to] = windowOf(entries.length, selected, Math.max(3, height - 10));
  const t = picked && "torrent" in picked ? picked.torrent : null;
  const audio = t ? audioLabel(t.name) : "";
  return (
    <Box flexDirection="column">
      <Text color={tintOf(screen.wanted.title.poster)} bold wrap="truncate">
        {screen.label.toUpperCase()}
      </Text>
      {report ? (
        <SiteLine sites={report.sites} hidden={screen.hidden} />
      ) : (
        <Text color={C.mute}>
          <Spinner /> asking the sites
        </Text>
      )}
      <Box marginTop={1}>
        <Columns>{"  Seeds      Size  Quality                   Src"}</Columns>
      </Box>
      {!entries.length && !asking ? (
        <Text color={C.warn}>
          {couch ? "No release every browser can play (MP4, H.264) for this one; plain flick still plays it. " : ""}No sources found.
        </Text>
      ) : null}
      <Box>
      <Box flexDirection="column" width={54} flexShrink={1}>
      {entries.slice(from, to).map((entry, i) => {
        if ("heading" in entry) return <SectionHeading key={entry.heading} text={entry.heading} />;
        const on = from + i === selected;
        const s = entry.torrent;
        const tag = sourceTag(s.source);
        const sq = parseQuality(s.name);
        return (
          <Box key={s.infoHash + (entry.pick ? "pick" : "")} flexShrink={0}>
            <Pointer on={on} />
            <Text wrap="truncate">
              <Text color={s.seeders > 20 ? C.good : s.seeders > 0 ? C.warn : C.bad}>{String(s.seeders).padStart(5)}</Text>
              <Text color={C.mute}>{humanSize(s.bytes).padStart(10)}  </Text>
              <Badge text={resolutionLabel(sq.res).padEnd(5)} color={RES_COLOR[sq.res] ?? C.rule} />
              {sq.hdr ? <Badge text={sq.hdr.padEnd(3)} color={C.bad} /> : "     "}
              <Text color={on ? C.accent : C.text} bold={on}>
                {` ${[sq.codec, sq.src].filter(Boolean).join(" ")}`.padEnd(14)}
              </Text>
              <Text color={SOURCE_COLOR[tag] ?? C.mute}>{tag}</Text>
            </Text>
          </Box>
        );
      })}
      </Box>
      <Scrollbar total={entries.length} from={from} visible={to - from} height={to - from} />
      </Box>
      {t ? (
        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          <Text color={C.text} wrap="truncate">
            {t.name}
          </Text>
          <Text wrap="truncate">
            <Text color={C.mute}>{audio ? `audio ${audio}` : "audio not in the name"}</Text>
            {couch ? null : whyNotCouch(t.name) === null ? (
              <Text color={C.good}>{"  ·  ✓ couch"}</Text>
            ) : (
              <Text color={C.rule}>{`  ·  ✗ couch: ${whyNotCouch(t.name)}`}</Text>
            )}
          </Text>
          {picked && "pick" in picked && picked.pick ? (
            <Text wrap="truncate">
              <Badge text="PICK" color={C.accent} />
              <Text color={C.mute}> 1080p x264 under 6 GB, the most seeders</Text>
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

function Playing({ screen, couch, upload, barWidth }: { screen: Extract<Screen, { kind: "playing" }>; couch?: Couch; upload: number | null; barWidth: number }) {
  const d = useDetails(screen.title?.id ?? null);
  const p = screen.progress;
  const t = screen.torrent;
  const q = parseQuality(t.name);
  const tag = sourceTag(t.source);
  const audio = audioLabel(t.name);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={tintOf(screen.title?.poster ?? "")} bold>
        {screen.label.toUpperCase()}
      </Text>
      {screen.error ? (
        <Text color={C.bad}>✗ {screen.error}</Text>
      ) : (
        <Text color={C.text}>
          {p ? <Text color={C.good}>●</Text> : <Spinner />} {screen.status}
        </Text>
      )}
      {p ? (
        <Box flexDirection="column" marginTop={1}>
          <FilmStrip percent={p.percent} width={Math.max(12, barWidth)} rolling={p.percent < 100 && p.downBytesPerSec > 0} />
          <Text color={C.mute} wrap="truncate">
            {downloadLine(p, t.bytes)}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text color={C.mute} wrap="truncate">
          {t.name}
        </Text>
        {q.res || q.codec || q.src || audio ? (
          <Text wrap="truncate">
            {q.res ? <Badge text={resolutionLabel(q.res)} color={RES_COLOR[q.res] ?? C.rule} /> : null}
            <Text color={C.mute}>{` ${[q.codec, q.src].filter(Boolean).join(" ")}${audio ? ` · audio ${audio}` : ""}`}</Text>
            {t.source !== "pasted" ? <Text color={SOURCE_COLOR[tag] ?? C.mute}>{` · ${tag}`}</Text> : null}
          </Text>
        ) : null}
      </Box>
      {couch && !screen.error ? (
        <RoomCard couch={couch} torrent={t} minutes={d?.minutes ?? 0} upload={upload} />
      ) : d ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={C.mute} wrap="truncate">
            {[screen.title?.year, d.minutes ? `${d.minutes} min` : null, d.genres.join(", ")].filter(Boolean).join(" · ")}
          </Text>
          {d.directors.length ? (
            <Text wrap="truncate">
              <Text color={C.rule}>{spaced("director") + "   "}</Text>
              <Text color={C.text}>{d.directors.join(", ")}</Text>
            </Text>
          ) : null}
          {d.cast.length ? (
            <Text wrap="truncate">
              <Text color={C.rule}>{spaced("cast") + "   "}</Text>
              <Text color={C.text}>{d.cast.join(", ")}</Text>
            </Text>
          ) : null}
          <Box marginTop={1} flexDirection="column">
            {clip(d.plot, Math.max(30, barWidth + 10), 3).map((line, i) => (
              <Text key={i} color={C.text} italic>
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

/** "23% · 1.0 of 4.4 GB · 3.1 MB/s · 41 peers · about 18 min to the end". Pure. */
export function downloadLine(p: Progress, totalBytes: number): string {
  const peers = `${p.peers} ${p.peers === 1 ? "peer" : "peers"}`;
  if (p.percent >= 100) return `on disk · ${peers}`;
  const parts = [`${p.percent}%`];
  if (totalBytes) parts.push(`${humanSize((totalBytes * p.percent) / 100)} of ${humanSize(totalBytes)}`);
  parts.push(`${humanSize(p.downBytesPerSec)}/s`, peers);
  if (totalBytes && p.downBytesPerSec > 0) {
    const minutes = Math.max(1, Math.round((totalBytes * (1 - p.percent / 100)) / p.downBytesPerSec / 60));
    parts.push(`about ${minutes} min to the end`);
  }
  return parts.join(" · ");
}

/** couch: who's there and since when, where the room is in the film, and
 *  whether this computer's upload keeps up. The link, once. */
function RoomCard({ couch, torrent, minutes, upload }: { couch: Couch; torrent: Torrent; minutes: number; upload: number | null }) {
  const seated = couch.room.seated();
  const s = couch.room.state;
  const at = clock(currentTime(s));
  const length = minutes ? `  of ${clock(minutes * 60)}` : "";
  const last = couch.room.lastChange;

  // The film's bitrate times the people watching (the host streams from the
  // room too) is what the upload has to keep up with.
  const bitrate = torrent.bytes && minutes ? torrent.bytes / (minutes * 60) : 0;
  const need = bitrate * seated.length;
  let health = <Text color={C.mute}>upload idle</Text>;
  if (s.playing && seated.length && upload !== null) {
    const ok = !need || upload >= need * 0.9;
    health = (
      <Text color={ok ? C.good : C.warn}>
        ↑ {humanSize(upload)}/s{need ? ` · the film needs ${humanSize(need)}/s` : ""} · {ok ? "keeping up" : "may buffer"}
      </Text>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={C.bulb} bold>
        {spaced("the room")}
      </Text>
      <Text wrap="truncate">
        {seated.length ? (
          seated.map((seat, i) => (
            <Text key={seat.id + i}>
              {i ? "     " : ""}
              <Text color={C.text}>{seat.name}</Text>
              <Text color={C.rule}>{` ${sinceLabel(Date.now() - seat.since)}`}</Text>
            </Text>
          ))
        ) : (
          <Text color={C.mute}>nobody yet: send the link below</Text>
        )}
      </Text>
      <Text>
        {!s.src ? (
          <Text color={C.mute}>waiting for the film…</Text>
        ) : s.playing ? (
          <Text color={C.accent}>▶ {at}</Text>
        ) : (
          <Text color={C.text}>
            ❚❚ {at}
            <Text color={C.mute}>{last?.action === "pause" ? `  paused by ${last.by}` : ""}</Text>
          </Text>
        )}
        <Text color={C.mute}>{s.src ? length : ""}</Text>
      </Text>
      {health}
      {couch.link ? (
        <Box marginTop={1}>
          <Text color={C.accent}>{couch.link}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** How long someone has been in the room: "just joined", "here 4 min",
 *  "here 1 h 20 min". Pure. */
export function sinceLabel(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just joined";
  if (minutes < 60) return `here ${minutes} min`;
  return `here ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function Help() {
  const lines = [
    ["type", "search films and shows (IMDb)"],
    ["⏎", "open a title, an episode, or play a source"],
    ["↑ ↓", "move"],
    ["tab", "the programme: continue, now showing, shows"],
    ["← →", "change season"],
    ["c", "couch: copy the room link while a film is on"],
    ["esc", "back, clear the search, or home"],
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
      <Box marginTop={1}>
        <Text color={C.mute}>any key closes this</Text>
      </Box>
    </Box>
  );
}
