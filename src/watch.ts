// One film, start to finish: open the torrent, find subtitles, start the
// player, report progress, and stop the torrent when the player closes.

import type { Engine } from "./engines.ts";
import { play, type PlayerName } from "./players.ts";
import { recordPlay, touchFilm, trimCache } from "./store.ts";
import { englishSubtitles } from "./subtitles.ts";
import type { Title } from "./titles.ts";
import { withTrackers, type Torrent } from "./torrents.ts";

export type Progress = { percent: number; downBytesPerSec: number; peers: number };

export type Session = {
  closed: Promise<void>; // resolves once the player is closed and the torrent stopped
  stop(): void;
};

export async function watch(options: {
  title: Title | null; // null for a pasted magnet
  name: string; // shown in the player's window title
  episode?: { season: number; number: number; tag: string };
  torrent: Torrent;
  engine: Engine;
  player: PlayerName;
  cacheGB: number;
  onStatus(message: string): void;
  onProgress(progress: Progress): void;
}): Promise<Session> {
  const { title, engine, onStatus } = options;

  onStatus("finding peers…");
  const stream = await engine.open(withTrackers(options.torrent.magnet));
  const video = stream.videos[0];
  if (!video) {
    await stream.stop();
    throw new Error("this torrent has no video file in it, pick another source");
  }

  onStatus("looking for English subtitles…");
  const torrentSub = stream.subtitles[0] ? { url: stream.urlOf(stream.subtitles[0]), name: stream.subtitles[0].name } : null;
  const subs = await englishSubtitles(title?.id ?? "", torrentSub);

  if (title) {
    recordPlay(
      { id: title.id, name: title.name, year: title.year, kind: title.kind, poster: title.poster, season: options.episode?.season, episode: options.episode?.number },
      options.episode?.tag,
    );
  }
  touchFilm(stream.folder);
  trimCache(options.cacheGB, stream.folder);

  onStatus(`playing in ${options.player}${subs ? ", English subtitles on" : ""}`);
  const playing = play(options.player, { url: stream.urlOf(video), title: options.name, subtitle: subs?.path ?? null, vtt: subs?.vtt ?? null });

  const timer = setInterval(async () => options.onProgress(await stream.progress()), 2000);
  const closed = playing.closed.then(async () => {
    clearInterval(timer);
    await stream.stop(); // nothing keeps uploading once the film is closed
  });
  return { closed, stop: () => playing.stop() };
}
