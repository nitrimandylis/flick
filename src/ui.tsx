// The full-screen terminal UI, built with Ink (React for terminals).
// Screens: browse (search bar + list) -> episodes (shows only) -> sources -> playing.

import { Box, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import { animeQueries, animeTitles, findAnime, type Anime } from "./anime.ts";
import type { Engine } from "./engines.ts";
import type { PlayerName } from "./players.ts";
import { loadHistory, type Watched } from "./store.ts";
import { details, episodes, isSeries, searchTitles, seasons, sxxeyy, trending, type Episode, type Title } from "./titles.ts";
import { findSources, hashOf, humanSize, magnetFromHash, qualityLabel, type Torrent, type Wanted } from "./torrents.ts";
import { watch, type Progress, type Session } from "./watch.ts";

const C = {
  accent: "#3DF5FF", // couch's cyan
  text: "#E8F1F5",
  mute: "#7D8A9A",
  good: "#86D6A2",
  warn: "#F0C560",
  bad: "#FF3DCB",
};

const LOGO = [" █▀▀ █   █ █▀▀ █▄▀", " █▀  █▄▄ █ █▄▄ █ █"];

const SOURCE_COLOR: Record<string, string> = { YTS: C.good, EZTV: C.warn, TPB: "#5FD0C5", Nyaa: "#D8B4FE" };

type Row = { title: Title; note: string }; // a title in the browse list

type Screen =
  | { kind: "browse" }
  | { kind: "episodes"; title: Title; anime: Anime | null; seasons: number[]; season: number; list: Episode[] }
  | { kind: "sources"; wanted: Wanted; label: string; episodeTag?: string; torrents: Torrent[] | null; offline: string[] }
  | { kind: "playing"; label: string; status: string; progress: Progress | null; error: string | null };

export function App(props: { engine: Engine; player: PlayerName; cacheGB: number; dub: boolean; initialQuery: string }) {
  const { exit } = useApp();
  const { rows: height } = useWindowSize();
  const [query, setQuery] = useState(props.initialQuery);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState(0);
  const [screen, setScreen] = useState<Screen>({ kind: "browse" });
  const [busy, setBusy] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const session = useRef<Session | null>(null);
  const searchId = useRef(0);

  // ---------- loading lists ----------

  // Empty search: continue watching, then what's trending. Otherwise: search IMDb.
  useEffect(() => {
    const id = ++searchId.current;
    const timer = setTimeout(async () => {
      if (!query.trim()) {
        const recent: Row[] = loadHistory().map((w: Watched) => ({
          title: { id: w.id, name: w.name, year: w.year, kind: w.kind, poster: w.poster, cast: "", rating: null },
          note: w.episode ? `continue ${sxxeyy(w.season ?? 1, w.episode)}` : "watched",
        }));
        setRows(recent);
        setBusy("loading what's trending…");
        const [films, shows] = await Promise.all([trending("movie"), trending("tvSeries")]);
        if (id !== searchId.current) return;
        setRows([...recent, ...films.map((t) => ({ title: t, note: "trending film" })), ...shows.map((t) => ({ title: t, note: "trending show" }))]);
        setBusy("");
        return;
      }
      setBusy("searching…");
      const found = await searchTitles(query);
      if (id !== searchId.current) return;
      setRows(found.map((t) => ({ title: t, note: t.cast })));
      setSelected(0);
      setBusy("");
    }, 250); // wait for typing to pause
    return () => clearTimeout(timer);
  }, [query]);

  async function openTitle(title: Title) {
    if (!isSeries(title)) return openSources({ kind: "film", title }, `${title.name}${title.year ? ` (${title.year})` : ""}`);
    setBusy(`loading ${title.name}…`);
    const anime = await findAnime(title.name);
    if (anime) {
      const list = Array.from({ length: anime.episodes }, (_, i) => ({ season: 1, number: i + 1, name: anime.episodeNames[i + 1] ?? "", rating: null }));
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
    setScreen({ kind: "sources", wanted, label, episodeTag, torrents: null, offline: [] });
    setSelected(0);
    const report = await findSources(wanted);
    setScreen({ kind: "sources", wanted, label, episodeTag, torrents: report.torrents, offline: report.offline });
  }

  async function startWatching(torrent: Torrent, title: Title | null, label: string, episode?: { season: number; number: number; tag: string }) {
    setScreen({ kind: "playing", label, status: "starting…", progress: null, error: null });
    const update = (change: Partial<Extract<Screen, { kind: "playing" }>>) =>
      setScreen((s) => (s.kind === "playing" ? { ...s, ...change } : s));
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

  useInput((input, key) => {
    if (key.ctrl && input === "c") return quit();
    if (showHelp) return setShowHelp(false);

    if (screen.kind === "playing") {
      if (key.escape || input === "q" || key.return) {
        if (session.current) session.current.stop();
        else setScreen({ kind: "browse" }); // it failed to start: go back
      }
      return;
    }

    const length =
      screen.kind === "browse" ? rows.length : screen.kind === "episodes" ? screen.list.length : (screen.torrents?.length ?? 0);
    if (key.upArrow) return setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) return setSelected((i) => Math.min(Math.max(0, length - 1), i + 1));

    if (screen.kind === "browse") {
      if (key.return && rows[selected]) return void openTitle(rows[selected].title);
      if (key.escape) return query ? setQuery("") : quit();
      if (key.backspace || key.delete) return setQuery((q) => q.slice(0, -1));
      if (input === "?" && !query) return setShowHelp(true);
      if (input && !key.ctrl && !key.meta) return setQuery((q) => q + input);
      return;
    }

    if (key.escape || input === "q") {
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

    if (screen.kind === "sources") {
      const torrent = screen.torrents?.[selected];
      if (key.return && torrent) {
        const ep = screen.wanted.kind === "episode" ? { season: screen.wanted.season, number: screen.wanted.episode, tag: screen.episodeTag ?? "" } : undefined;
        const animeEp = screen.wanted.kind === "anime" && screen.episodeTag ? { season: 1, number: Number(screen.episodeTag.slice(4)), tag: screen.episodeTag } : undefined;
        return void startWatching(torrent, screen.wanted.title, screen.label, ep ?? animeEp);
      }
    }
  });

  function resumeIndex(id: string): number {
    const last = loadHistory().find((w) => w.id === id);
    return last?.episode ? Math.max(0, last.episode) : 0; // the episode after the last one played
  }

  async function quit() {
    session.current?.stop();
    await props.engine.shutdown(); // no torrent keeps seeding after flick closes
    exit();
  }

  // ---------- drawing ----------

  const listHeight = Math.max(5, height - 12);
  const footer =
    screen.kind === "browse"
      ? "type to search · ↑↓ move · ⏎ open · paste a magnet to play it · esc clear/quit · ? help"
      : screen.kind === "episodes"
        ? "←→ season · ↑↓ episode · ⏎ sources · esc back"
        : screen.kind === "sources"
          ? "↑↓ move · ⏎ play · esc back"
          : "⏎ or esc stops the film";

  return (
    <Box flexDirection="column" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Box flexDirection="column">
          {LOGO.map((line) => (
            <Text key={line} color={C.accent}>
              {line}
            </Text>
          ))}
        </Box>
        <Text color={C.mute}>
          {props.engine.name} · {props.player}
        </Text>
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor={screen.kind === "browse" ? C.accent : C.mute} paddingX={1}>
        <Text color={C.accent}>⌕ </Text>
        {screen.kind === "browse" ? (
          query ? <Text color={C.text}>{query}<Text color={C.accent}>▌</Text></Text> : <Text color={C.mute}>search films and shows, or paste a magnet</Text>
        ) : (
          <Text color={C.text}>{screen.kind === "episodes" ? screen.title.name : screen.label}</Text>
        )}
      </Box>

      <Box marginTop={1} flexGrow={1} flexDirection="column">
        {showHelp ? <Help /> : null}
        {!showHelp && screen.kind === "browse" ? <TitleList rows={rows} selected={selected} height={listHeight} /> : null}
        {!showHelp && screen.kind === "episodes" ? <EpisodeList screen={screen} selected={selected} height={listHeight} /> : null}
        {!showHelp && screen.kind === "sources" ? <SourceList screen={screen} selected={selected} height={listHeight} /> : null}
        {!showHelp && screen.kind === "playing" ? <Playing screen={screen} /> : null}
      </Box>

      <Box>
        <Text color={busy ? C.accent : C.mute}>{busy || footer}</Text>
      </Box>
    </Box>
  );
}

/** The slice of a long list that fits, keeping the selection visible. Pure. */
export function windowOf(length: number, selected: number, height: number): [number, number] {
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), length - height));
  return [start, Math.min(length, start + height)];
}

/** A short tag for a source: Knaben passes through tracker names like "The Pirate Bay". Pure. */
export function sourceTag(source: string): string {
  if (/pirate/i.test(source)) return "TPB";
  if (/^yts|yify/i.test(source)) return "YTS";
  if (/eztv/i.test(source)) return "EZTV";
  if (/nyaa/i.test(source)) return "Nyaa";
  return source.replace(/\s+/g, "").slice(0, 6);
}

function Pointer({ on }: { on: boolean }) {
  return <Text color={C.accent}>{on ? "❯ " : "  "}</Text>;
}

function TitleList({ rows, selected, height }: { rows: Row[]; selected: number; height: number }) {
  if (!rows.length) return <Text color={C.mute}>Nothing yet. Start typing.</Text>;
  const [from, to] = windowOf(rows.length, selected, height);
  return (
    <Box flexDirection="column">
      {rows.slice(from, to).map((row, i) => {
        const on = from + i === selected;
        const t = row.title;
        return (
          <Box key={t.id + row.note}>
            <Pointer on={on} />
            <Text color={on ? "#FFFFFF" : C.text} bold={on}>
              {t.name}
            </Text>
            <Text color={C.mute}>
              {t.year ? `  ${t.year}` : ""}
              {isSeries(t) ? "  show" : ""}
              {t.rating ? `  ★ ${t.rating}` : ""}
              {row.note ? `  ${row.note}` : ""}
            </Text>
          </Box>
        );
      })}
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
            <Box key={tag}>
              <Pointer on={on} />
              <Text color={C.mute}>{screen.anime ? String(ep.number).padStart(3) : tag} </Text>
              <Text color={seen.has(tag) ? C.good : C.mute}>{seen.has(tag) ? "✓ " : "  "}</Text>
              <Text color={on ? "#FFFFFF" : C.text} bold={on}>
                {ep.name || `Episode ${ep.number}`}
              </Text>
              <Text color={C.mute}>{ep.rating ? `  ★ ${ep.rating}` : ""}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function SourceList({ screen, selected, height }: { screen: Extract<Screen, { kind: "sources" }>; selected: number; height: number }) {
  if (!screen.torrents) return <Text color={C.accent}>asking YTS, EZTV, The Pirate Bay, Knaben and Nyaa…</Text>;
  if (!screen.torrents.length) return <Text color={C.warn}>No sources found{screen.offline.length ? ` (offline: ${screen.offline.join(", ")})` : ""}.</Text>;
  const [from, to] = windowOf(screen.torrents.length, selected, height - 1);
  return (
    <Box flexDirection="column">
      {screen.offline.length ? <Text color={C.warn}>offline right now: {screen.offline.join(", ")}</Text> : null}
      {screen.torrents.slice(from, to).map((t, i) => {
        const on = from + i === selected;
        const tag = sourceTag(t.source);
        return (
          <Box key={t.infoHash}>
            {/* fixed-width columns never shrink; only the release name truncates */}
            <Box flexShrink={0}>
              <Pointer on={on} />
              <Text color={t.seeders > 20 ? C.good : t.seeders > 0 ? C.warn : C.bad}>{String(t.seeders).padStart(5)}▲ </Text>
              <Text color={C.mute}>{humanSize(t.bytes).padStart(8)}  </Text>
              <Text color={C.text}>{qualityLabel(t.name).slice(0, 22).padEnd(23)}</Text>
              <Text color={SOURCE_COLOR[tag] ?? C.mute}>{tag.padEnd(7)}</Text>
            </Box>
            <Box flexGrow={1} minWidth={0}>
              <Text color={on ? "#FFFFFF" : C.mute} wrap="truncate">
                {t.name}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function Playing({ screen }: { screen: Extract<Screen, { kind: "playing" }> }) {
  const p = screen.progress;
  return (
    <Box flexDirection="column">
      <Text color={C.text} bold>
        {screen.label}
      </Text>
      {screen.error ? (
        <Text color={C.bad}>✗ {screen.error}</Text>
      ) : (
        <Text color={C.accent}>● {screen.status}</Text>
      )}
      {p ? (
        <Text color={C.mute}>
          {p.percent >= 100 ? "fully downloaded" : `${p.percent}% downloaded · ↓ ${humanSize(p.downBytesPerSec)}/s · ${p.peers} peers`}
        </Text>
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
